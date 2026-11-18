# 当前店铺业绩接入 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for isolated implementation and review tasks. Preserve all unrelated working-tree changes; do not commit the whole dirty workspace.

**Goal:** 将当前已授权美国站 Haul 店铺的订单同步、SKU 运营归属和每日业绩连到现有首页及业绩页。

**Architecture:** 沿用单例店铺连接、现有账号和 SKU 规则。订单以订单号和商品行号去重，保留源数量、状态、金额组成及版本；工作流按固定时间窗读取全部分页，成功后推进同步水位，失败不推进。报表采用带版本的临时口径，来源报表与日期基准保持未确认，并允许之后从保留明细重算。

**Tech Stack:** TypeScript / Hono / React / Cloudflare Workflows / D1 / Vitest / Playwright。

用户已明确要求开始实施；本计划直接执行。当前分支为 codex/order-sorting，已有大量未提交工作，所有改动限定到本功能及必要注册点。

## 任务与验收

- [x] 1. 订单事实：新增 `packages/store-sales/facts.ts`、`migrations/0050_performance_facts.sql` 和对应集成测试。先测试重复页、取消不抹除源数量、金额不重复乘件数、旧版本不覆盖新版本、未知币种及缺金额。测试失败后实现解析和幂等落库。
- [x] 2. 同步工作流：新增 `sync.ts` 和 `0051_performance_sync.sql`；复用当前授权和 Orders API 的共用限流。首次回填最近 7 个完整美西日及今天，之后以更新时间增量并重叠回扫；失败重启不跳过窗口。单店互斥，逐页持久化，凭据变更拒绝继续旧任务。手动同步和每半小时触发不发送群消息。
- [x] 3. SKU 归属与日报：新增 `live.ts`；从订单生成 SKU 清单，优先现有人工归属，再用现有运营规则。管理员可修正归属并留痕。真实日报保留未归属、缺金额、取消行，不将缺失当作已对账的 0。仅管理员可看全员明细，其他账号只能看本人明细和团队总计。
- [x] 4. 页面：改造 `store-sales.tsx` 与专属样式。显示真实数据、同步状态、失败原因、数据覆盖范围、口径待确认状态；管理员可同步与管理 SKU 归属。保留独立模拟预览，真实历史链接不带 preview。新增刊登未接入时显示待接入而非伪造为 0。
- [x] 5. 验证与落地：运行事实/工作流/接口/权限测试、现有销量回归、类型检查、构建和 Workers dry run；真实运行环境检查。数据库只新增表；发布前检查当前线上版本与本地既有改动，避免附带发布不相关功能。记录部署及实测结果。

## 核心契约

```ts
// 保留独立口径对象，不接受未实现的“发货日”假开关。
const provisionalPolicy = {
  version: 'orders-created-v1-draft', status: 'pending_confirmation',
  sourceReport: null, confirmedDateBasis: null,
  appliedDateBasis: 'purchased_at', timezone: 'America/Los_Angeles',
  quantity: 'source_quantity_ordered', cancellation: 'retain_source_quantity',
  refunds: 'not_applied', ownership: 'current_assignment',
}
// 读取 /api/store-sales；管理员 POST /api/store-sales/sync，
// GET /api/store-sales/skus?q=...；POST /api/store-sales/owner {sku,accountId}。
```

## 检查命令

```powershell
pnpm exec vitest run tests/integration/performance-facts.test.ts tests/integration/performance-sync.test.ts tests/integration/performance-live.test.ts tests/integration/store-sales.test.ts
pnpm typecheck
pnpm build
pnpm check:workers
```

## 不在本次范围

第二店铺、备货自动决策、完整商品跟进表、财务结算利润、导入旧 Excel 历史数字均不属于本次接入。取消/退款及报表口径保持可追溯，不宣称已与尚未提供的导出报表一致。

## 官方接口依据

- [Amazon searchOrders](https://developer-docs.amazon.com/sp-api/reference/searchorders)：固定查询窗、分页、时间截止至少滞后 2 分钟。
- [Orders migration guide](https://developer-docs.amazon.com/sp-api/docs/orders-api-migration-guide)：商品行 proceeds 分解，单价与行小计区分。
- [Cloudflare Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)：步骤内持久化副作用必须幂等。

## 实施结果

2026-11-17：全部开发、测试、隔离发布和线上页面验证已完成。0050/0051 已应用，API 与 Jobs 已上线，真实首轮同步已启动；截至 08:02:27 UTC 已入库 2,590 行，首轮回填仍在进行。详细版本、口径与验证记录见项目 outputs/htcerp-performance-review/当前店铺业绩接入_上线记录.md。
