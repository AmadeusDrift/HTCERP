# HTCERP 业务 API

在 HTCERP 的「设置 → 业务 API」创建接入。令牌默认有效 7 天，可选 1–90 天，只在创建和轮换时展示。令牌绑定当前 HTCERP 配置的美国站店铺。调用方从自己的后台发送 `Authorization: Bearer <HTCERP令牌>`。

本机 HTC Haul ERP 使用 `https://htcerp.app/api/partner/v1`。新建专用接入后，保留「商品 Listing 与上架数据」，再开启「Haul 订单商品同步」。在本机设置中填写相同 Seller ID、美国站 `ATVPDKIKX0DER`、币种 `USD` 和接入令牌，然后手动刷新。Windows 按当前系统用户加密保存令牌。令牌轮换后，在本机更新令牌即可继续增量同步。

## 读取接口

| 方法及路径 | 权限 | 输入与输出 |
| --- | --- | --- |
| `GET /connection` | 有效令牌 | 当前卖家、站点、到期时间和权限清单 |
| `GET /sales` | `sales.read` | `date=YYYY-MM-DD`，可选 `sku`。返回 Amazon Haul 件数、销售额、截止时间和数据更新时间。按美西日期统计。 |
| `GET /orders` | `orders.read` | `since`、`until`、可选 `cursor`。按更新时间同步 Haul 订单商品，返回 SKU、件数、金额、折扣、状态和稳定的替代标识。 |
| `GET /listings` | `listings.read` | 同上。仅返回有 Haul 标识的 Listing，包含创建时间和父子类型。 |
| `GET /inventory` | `inventory.read` | `sku`。返回当前授权对应的 Haul FBA 报告快照、时间戳和 FNSKU，范围是报告覆盖的 JIT 或 J1T SKU。 |
| `GET /catalog` | `catalog.read` | `query`。返回最多 10 条商品目录命中。 |
| `GET /offers` | `offers.read` | `asin`。返回商品报价摘要。 |
| `GET /feedback` | `feedback.read` | `asin`。返回评论主题及指标。 |
| `GET /listing-issues` | `issues.read` | `sku`。返回问题代码、严重程度和受影响字段。 |
| `GET /reports` | `reports.read` | 最新完整库存与 Listing 报告的时间和行数。 |

默认开启销量、Listing 和库存读取。订单、目录、报价、评论、问题及报告权限由管理员单独开启。库存 `item: null` 表示快照未覆盖该 SKU。库存 `item.fnsku` 仅在有唯一匹配时返回字符串，`item.fnskus` 返回当前 Haul 快照中该 SKU 的所有 FNSKU；数组为空表示快照未提供匹配。更换 Amazon 凭据后，库存和报告等待新凭据生成的完整快照。

订单和 Listing 的时间范围使用带时区的 ISO 8601，左闭右开，最多 7 天，结束时间至少早于当前两分钟。Listing 遇到高密度范围会在服务端自动拆窗。调用方保持原始的 `since` 和 `until`，逐次带回 `next_cursor`，直到它为 `null`。即使本页 `items` 为空，有游标也必须继续。游标绑定接入方、操作和查询范围，有效 30 分钟。游标过期或收到 `LISTING_WINDOW_CHANGED` 时，用相同范围从第一页恢复，按 SKU 或订单商品稳定标识幂等合并。极少数单个时间戳达到上限的窗口会返回 `WINDOW_TOO_LARGE`，需用商品报告补齐。

`complete: false` 表示不能推进同步水位。部分取消、金额口径无法确认的订单商品行进入待核对。`/sales` 使用 Amazon 销量指标，和本机从订单商品重算的商品金额可能存在口径差异。`429` 时按 `Retry-After` 等待，再用原参数和原游标重试。`401` 检查令牌是否暂停、过期或已轮换，`403` 检查权限，`409 CONNECTION_CHANGED` 联系管理员重新绑定。

## 写入接口

| 路径 | 权限 | JSON 参数 |
| --- | --- | --- |
| `POST /inventory/requests` | `inventory.request` | `sku`、`quantity`，可选 `expectedQuantity` |
| `POST /inventory/quantity` | `inventory.quantity.write` | `sku`、`quantity`、`expectedQuantity` |
| `POST /prices` | `price.write` | `sku`、`audience`、`cents`、`expectedCents`。`BZR` 是 Haul 报价，`ALL` 是普通报价。 |
| `GET /requests/{id}` | 同一提交方的有效令牌 | 查询申请状态、Amazon 提交编号和核对结果。 |

写入总开关和每项写入权限初始均关闭。管理员开启总开关并授予对应权限后，接入方可提交申请。每个写请求发送 `Content-Type: application/json` 和唯一 `Idempotency-Key`。网络重试继续使用相同键和相同内容。一个键对应一个写入申请，内容变化返回 `409`。成功提交申请返回 `202 PENDING`。系统在管理员逐笔批准后检查当前值和 Amazon 预检，验证通过才提交实际修改。库存数量直接写入支持普通卖家自配送的 `DEFAULT` 渠道。SellerFlex 的 JIT/J1T 库存交由管理员使用现有仓库流程处理，再登记结果。Amazon 接收请求后返回 `ACCEPTED`，核对到目标值才记为 `CONFIRMED`。遇到发送结果不明时先核对 Amazon。

暂停接入、关闭写入、收回权限或轮换令牌都会阻止后续授权。尚待审批的相关申请会被取消。管理员可以在同一页看到接入方、调用范围、时间、状态和返回行数。每个接入方每分钟最多 60 次请求，其中写入申请最多 10 次。

合作方联调用合成数据。正式接入之前，应按 Amazon 的授权用途核实接收方和数据范围。令牌由管理员放到获准的运行环境。参考 [Amazon 可接受使用政策](https://sellercentral.amazon.com/solution-provider/policy?policyType=AUP&locale=en_US)。
