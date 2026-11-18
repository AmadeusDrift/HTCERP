# 订单分拣商品标签接入

`downloadMergedProductLabels` 可以直接从订单分拣的已鉴权路由调用。函数返回 PDF 下载响应，失败时抛出 `PublicError`，由现有 API 错误处理返回提示。

## 路由和按钮

接入时按分拣记录 ID 和备货分组取已保存的 `plan.groups[].raw`，并验证用户可以访问记录和分组。请求参数只需要记录和分组标识。SKU、FNSKU、备货件数以及店铺站点由服务端确定。

```ts
import { downloadMergedProductLabels } from '../product-labels/download'

return downloadMergedProductLabels(c.env, {
  sellerAccountId: scope.sellerAccountId,
  marketplaceId: 'ATVPDKIKX0DER',
  region: 'NA',
  locale: 'en_US',
  filename: `${group.filename.replace(/\.xlsx$/i, '')}-合并标签`,
  lines: group.raw.map(([, sku, fnsku, , units]) => ({ sku, fnsku, units })),
})
```

美国低价商城陶瓷挂件使用上面的站点参数。按钮放在分组结果，文案为「下载合并标签」。等待时禁用重复点击，收到失败响应时显示服务端错误，收到 PDF 后下载附件。模块使用现有 `amazon` 服务端授权。为其他店铺开放时，从已核对的店铺配置取 `marketplaceId`、`region` 和 `locale`。

## 私有模板文件

在目标环境的 `ARCHIVE` R2 桶配置以下三个对象。模板对应这次确认的欧代标版本。所有备货分组统一使用这一版本和 80 × 80 mm 尺寸。

| R2 对象                                     | 文件                                    |
| ------------------------------------------- | --------------------------------------- |
| `product-labels/eu-rep-ceramic-80mm-v1.pdf` | 工作区 `outputs/固定欧代标-80mm-v1.pdf` |
| `product-labels/cmaps/UniGB-UCS2-H.bcmap`   | 本目录 `cmaps/UniGB-UCS2-H.bcmap`       |
| `product-labels/cmaps/Adobe-GB1-UCS2.bcmap` | 本目录 `cmaps/Adobe-GB1-UCS2.bcmap`     |

两个字体映射供商品标签的中文字体编码使用，同目录保留了授权文件。Worker 从私有 R2 读取模板和映射。

## 行为和验收

- 校验正整数备货件数，每次最多输出 1,000 张，保持输入行的顺序和数量。同一个 SKU 对应多个 FNSKU 时返回错误。
- 仅用 Amazon SP-API `createMarketplaceItemLabels` 请求 70 × 30 mm 热敏原始标签。每个未缓存 SKU 只请求 1 张，每批最多 100 个不同 FNSKU，重复 FNSKU 的不同 SKU 分开请求。验证全部返回页的数量、尺寸和 FNSKU 后，拆为每 SKU 一个 PDF 缓存。
- 输出每页 80 × 80 mm，固定欧代在上、商品标在下；原标签以原尺寸嵌入，按备货件数重复。核对失败时整组返回错误，错误 PDF 不发布到缓存。
- 陶瓷挂件批次应返回 `X005EC4Z9R` 一张、`X005EC8JYT` 两张。下载后按实际大小打印，再用仓库扫码枪复核。
- 单元和接口回归可运行 `pnpm exec vitest run tests/integration/product-labels.test.ts`。


## ERP 持久缓存

部署前应用 `migrations/0053_product_label_cache.sql`。环境需要 `DB` D1 与可读写的 `ARCHIVE` R2。没有电脑端标签缓存；响应继续使用 `Cache-Control: no-store`。

- 原始标签键包含服务端确认的 `sellerAccountId`、站点、区域、语言、SKU、FNSKU 和请求尺寸。跨批次、改变数量可复用原始标签，不再请求 Amazon 或刷新授权。
- 合并 PDF 键包含同一店铺站点范围、完整有序行及数量、模板内容 SHA-256。文件名和 `batchId` 不影响复用。精确命中时返回 R2 已存字节。
- D1 使用 90 秒租约，每 20 秒续租；并发请求共享结果。失败即时释放，终止的 Worker 租约到期后可恢复；发布时校验持有者，过期持有者不能覆盖结果。等待超过 60 秒返回可重试提示。
- R2 使用不可变对象名，D1 只在写入成功后发布引用和内容哈希。读取时验证哈希，缺失或损坏对象会重新生成。过期写入偶尔留下未引用对象，可通过独立的维护流程清理；不能对整个缓存前缀设置短期删除规则。
- `productLabelTemplateRevision(env)` 校验模板后返回 SHA-256；下载响应头 `X-Product-Label-Template` 返回同一值。上层批次状态可据此失效旧模板产物。模板缺失或无效时不返回此前缓存的合并文件。
