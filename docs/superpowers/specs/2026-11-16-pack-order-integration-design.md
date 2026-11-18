# SellerFlex Pack → ERP 自动分拣

用户已授权在现有插件接 Pack 批量导出、完整订单传输、自动分拣及官方 SKU/FNSKU 标签输出，并联调。已明确：按 Transfer Id + SKU + FNSKU 跳过重复，数量改变待核对。保持自动补库暂停，不点击 Pack/Ship 提交动作。

## 已观察页面

`https://sellerflex.amazon.com/transshipments/pack`，仓库 A1C5。勾选订单后点击 `Download & print all transshipments`，出现 `Order List` 弹窗。表头 Product title / SKU / FNSKU / Transfer Id / Units，每行还有 Print、Download。批量按钮 Download order list 和 Download FNSKU labels。

真实 XLSX 只有 Order List 工作表，A2 Orders/SKUs/Units，A3 Warehouse:A1C5，A4 Shipout日期时间，row6表头，row7起全数据。实际标签 PDF 是一页多个标签，FNSKU 在图像里，不能靠 PDF 文本猜映射或拆页。因此先上传完整 XLSX、由服务器确认新增行，再对这些行调用官方 Download，保留对应 PDF；按组归档，并可合并 PDF 供打印。

## 设计

- 插件在 Order List 弹窗增加“同步到 ERP 并分拣”，也提供打开当前所选订单的入口；使用原生可见导出控件。后台复用既有 ERP 设备凭据，令牌不进网页。不会自动改变订单选中范围、标记打包或发货。
- MAIN 世界受限导出捕获仅在 Pack 路径且被本次导出流程临时开启时观察原生生成的 Blob，按期望 MIME/大小传递，过期自动关闭。无任意 URL 请求、无 cookies、无浏览历史、无 downloads 权限。
- 完整 XLSX 字节在扩展 IndexedDB 持久化后上传；网络失败保留并重放稳定请求 ID；后台闹钟可继续上传。内容脚本只用受限消息及当前弹窗完整快照。页面变更、刷新、关闭时停止标签采集，已存文件保留。
- 服务器解析原 XLSX、核验 A1C5/表头/行数/汇总、保存完整原文件及所有表格内容。服务端使用当前 ERP 属性分类。
- D1 原子事务：批次登记、行级去重记录、配置版本变更和分拣结果一起提交。行身份加入设备实际店铺/仓库范围。已处理同数量跳过；数量变化记录待核对；新行继续自动分拣。请求重试和跨设备同一导出均返回已有结果，重叠导出仅生成新行。
- 每次插件批次有独立命名空间，分组工作簿继续沿用原样表文件名并在独立批次 ZIP 内输出；不改变既有手动导入的同名冲突保护。
- 每个新增原始行对应标签上传槽，严格批次/行/来源快照匹配，PDF 原件私有保存，重复标签上传幂等，差异冲突拒绝。全部槽齐后标签完成；缺失明确展示，不伪报整批完成。数量变化项不产出待打印标签。
- ERP 显示 Pack 批次、原始/新增/跳过/待核对数、标签进度；提供分拣表、分组标签 PDF、原始文件及整批 ZIP，历史可重新下载。

## 合约

设备接口挂 `/api/inventory-device/pack-orders`：
- POST `/import` `{requestId:uuid,filename:string,base64:string,warehouse:'A1C5'}` → `PackBatch`。
- GET `/:id` → PackBatch（同scope）。
- POST `/:id/labels` `{rowIndex:number,filename:string,base64:string}` → PackBatch。

会话接口 `/api/order-sorting/pack`：GET `/batches`、GET `/:id`、GET `/:id/source`、GET `/:id/labels/:rowIndex`。会话只读现有ERP规则。类型由 packages/order-sorting/pack-types.ts 导出。

PackBatch: `{id,createdAt,filename,date,state:'LABELS_PENDING'|'READY'|'NO_NEW',totalRows,newRows,skippedRows,conflicts:[{rowIndex,sku,fnsku,transferId,previousUnits,units}],plan:SortPlan|null,templateKey:string,labels:[{rowIndex,sku,fnsku,transferId,units,group,filename,received:boolean}],sourceHash:string}`。导出行索引0基于原OrderList数据行顺序；原始空行处理保持解析器约定。设备永不接受客户端seller覆盖。

## 验证

先回归测试重复/跨设备/并发/数量变化/完整源文件/标签身份/回复丢失及刷新。受控本地Pack页面通过真实扩展代码生成样本 XLSX/PDF，上传本地 Worker，验证分拣表及标签下载。然后升级现有扩展、在线实际小批导出联调；不提交打包发货或库存变更。检查PDF渲染。复核原库存测试与暂停状态。
