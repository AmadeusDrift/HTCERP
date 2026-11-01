# HTCERP Super Agent 分阶段工程执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 2026-11-01 已获授权实施阶段 1、2，验收后部署并推送；按用户选择的阶段顺序执行，不默认启动子代理。

**Goal:** 让现有运营助手基于已接通的电商业务能力，自主完成有授权边界、费用上限和证据报告的选品调查。

**Architecture:** 对话负责接待，独立调查负责保存目标和执行状态，业务工具负责受权限和预算控制的操作。多步调查由现有 Jobs Worker 中新增的 AssistantWorkflow 执行；既有 ResearchWorkflow 继续处理研究业务。D1 保存状态，R2 保存证据，现有费用账本和服务队列继续使用。

**Tech Stack:** TypeScript、Hono、Zod、React、Cloudflare Workers / D1 / Workflows / R2、现有 OpenRouter 接入、Vitest、Playwright。

---

## 1. 文档用途与执行边界

这是项目分阶段路线与工程任务合同，配合[阶段总方案](../../../workbench/docs/AI-Agent-Super-Agent分阶段实施方案.md)使用。它说明实现位置、契约、顺序和验收，不预先生成整套实现代码。每阶段开始时先核对当时源码及迁移编号，在该阶段范围内按测试失败、最小实现、回归验证的顺序落地。

用户随后明确授权实施阶段 1、2，验收后直接上线并更新 GitHub。第三至第五阶段未获本轮实施授权；验收使用模拟模型，不提高线上预算、不触发供应商业务请求。

保留快速固定指令、旧对话和旧任务可读。新能力从读取开始，按阶段开放。每阶段独立验收后再推进后续范围。

## 2. 文件和职责

以下路径均相对仓库根目录；标为新增的文件尚不存在。

| 文件 | 操作 | 职责 / 开始阶段 |
| --- | --- | --- |
| `workbench/packages/assistant/agent.ts` | 修改 | 保留已有工具兼容，委托新注册表；阶段 1 |
| `workbench/packages/assistant/contracts.ts` | 新增 | 输入、工具结果、调查动作与报告校验；阶段 1 起增量扩展 |
| `workbench/packages/assistant/tools.ts` | 新增 | 明确注册的业务工具及参数校验；阶段 1 |
| `workbench/packages/assistant/policy.ts` | 新增 | 当前身份、对象权限、动作与额度检查；阶段 1 |
| `workbench/packages/catalog/service.ts` | 新增 | 从现有接口提取共用的商品查询与详情读取；阶段 1 |
| `workbench/packages/catalog/index.ts` | 修改 | 原 HTTP 返回兼容，调用共用查询；阶段 1 |
| `workbench/packages/amazon/panel.ts` | 新增 | 提取已有竞品面板读取，不触发在线查询；阶段 1 |
| `workbench/packages/amazon/routes.ts` | 修改 | 复用竞品读取，在线入口行为保持兼容；阶段 1 |
| `workbench/packages/assistant/model.ts` | 修改 | 页面上下文、历史组装与预算入口；阶段 1 起 |
| `workbench/packages/assistant/routes.ts` | 修改 | 快速问答、调查创建、状态、确认和控制接口；阶段 1 起 |
| `workbench/apps/web/src/assistant.tsx` | 修改 | 上下文、进度、确认和报告显示；阶段 1 起 |
| `workbench/apps/web/src/main.tsx` | 修改 | 传递当前筛选与页面对象；阶段 1 |
| `workbench/packages/assistant/runs.ts` | 新增 | 调查状态、步骤、租约、版本和关联任务；阶段 2 |
| `workbench/packages/assistant/loop.ts` | 新增 | 单步决策、工具执行、等待及终止；阶段 2 |
| `workbench/packages/assistant/report.ts` | 新增 | 结构化报告、证据校验与停止时的部分报告；阶段 2 |
| `workbench/apps/jobs/src/assistant-workflow.ts` | 新增 | 调查持久步骤执行；阶段 2 |
| `workbench/apps/jobs/src/index.ts` | 修改 | 导出助手工作流，阶段 3 增加完成通知 |
| `workbench/apps/api/src/access.ts`、`bindings.ts` | 修改 | 新路由角色、新工作流 binding；阶段 2 |
| `workbench/wrangler.api.jsonc`、`wrangler.jobs.jsonc` | 修改 | 新增助手工作流绑定，保留研究绑定；阶段 2 |
| `workbench/packages/assistant/budget.ts` | 新增 | 调查总额度、模型预留、子任务分配；阶段 2 起 |
| `workbench/packages/operations/execution.ts`、`jobs.ts`、`model.ts` | 修改 | 调查关联、预算传播、分析副作用控制；阶段 3 |
| `workbench/packages/connections/temu-reviews.ts`、`reviews.ts` | 修改 | 评论更新纳入费用与执行控制；阶段 3 |
| `workbench/packages/operations/service-queue.ts` | 按需要修改 | 调用沿用现有四队列，不另造调度系统；阶段 3 |
| `workbench/packages/assistant/playbook.ts` | 新增 | 已批准业务规则版本与说明；阶段 5 |

数据库基线最后一份迁移为 `0022_service_queue.sql`。计划阶段 2 新增 `0023_assistant_runs.sql`，阶段 3 新增 `0024_assistant_job_links.sql`；实际执行前检查编号是否被占用，顺延而不覆盖现有迁移。生产本地覆盖配置若使用单独的工作流列表，执行时同步检查，不能只改基础配置后宣称完成。

## 3. 统一契约

### 3.1 工具结果

读取工具返回统一结构；自然语言摘要由显示层或模型生成，不作为下一步唯一依据：

```json
{
  "version": 1,
  "status": "ok",
  "data": {"items": [{"id": "temu:US:123", "platform": "temu", "market": "US"}]},
  "coverage": {"total": 1, "returned": 1, "page": 1, "hasMore": false},
  "evidence": [{"id": "ev-1", "kind": "product_snapshot", "objectId": "temu:US:123", "observedAt": "2026-11-01T00:00:00Z", "fetchedAt": "2026-11-01T00:05:00Z"}],
  "missing": [],
  "warnings": []
}
```

`status` 为 `ok | partial | empty | denied | unavailable`。实际工具按各自 schema 返回业务字段；金额带币种，未知保留 null。`evidence.id` 由服务端建立可解析引用，不接受模型伪造的 ID。对模型不暴露 R2 原始路径、供应商原始响应或凭据。

第一批工具名固定为：`search_inventory`、`list_potential`、`read_product`、`read_reviews`、`read_amazon_comparison`、`my_jobs`、`read_job`。保留 `prepare_discovery` 的旧行为。在线动作在阶段 3 通过已确认 proposal 执行，不开放任意 HTTP 工具。

### 3.2 调查和步骤

`assistant_runs` 保存 account_id、conversation_id、origin_turn_id、目标、范围版本、策略版本、状态、限制、累计用量和报告。`assistant_steps` 保存 run_id、序号、稳定 action_key、参数摘要、状态、结果引用和用量关联。

状态集合：`queued | running | waiting_jobs | awaiting_confirmation | awaiting_input | pausing | paused | cancelling | cancelled | succeeded | partial | failed`。

模型每步只可选择四类动作：调用已注册工具、请求范围内补查、请求必要澄清、提交最终报告。状态转移、身份、次数和费用由程序裁决。阶段 2 不能执行补查，只能将缺口写入报告。

建议首版默认限制：12 次模型请求（含最终总结）、24 次工具调用、深入查看 10 款商品、同一调查串行执行、20 分钟主动执行时间。阶段 2 数据积分为 0。上述是拟定初始配置，尚未生效；隔离评估后可由管理员降低，不能因模型请求而提高。等待后台和人工确认不计入主动执行时间，但需独立等待期限。

每次调查创建时固定限制；跨日、刷新、恢复不重置。最后一次总结预留不足时，用已保存事实生成无新增模型请求的部分报告。

### 3.3 授权与费用

阶段 3 的 proposal 保存 scope_version、商品范围、动作、页数 / 调用数量、子研究数量、积分上限、AI 上限、观察池写入选项和有效期。确认必须由本人在服务端完成；重复确认返回相同 action_key 与关联任务，不能重新申请一份额度。

继续使用 `usage_reservations`，不建立第二套扣费账本。增加可空的调查关联列；保留原有 run_id / direct_key 约束和历史记录。`assistant_job_links` 记录调查给各子任务的额度分配和 job_id，唯一约束覆盖同一次调查、范围版本和动作标识。

子任务创建前，在 D1 原子分配额度并持久化待提交动作；异步提交用稳定 requestId 重放。未落账的分配占用可用额度，子任务实际消耗冲抵分配，不重复计入。终态后只释放明确未使用部分，uncertain 继续占用。团队日预算仍在每次真实发送前检查。

### 3.4 等待和交付

后台状态以 D1 为准。阶段 3 先用有期限的 Workflow sleep 和 D1 状态读取等待子任务，不调用模型或供应商轮询。完成通知可以加速唤醒，但通知丢失不能丢任务；恢复先核对数据库中的终态。

阶段 2 为每次调查保存一个当前报告；阶段 4 起报告追加版本。报告包含目标、范围、覆盖、推荐、排除、缺口、证据 ID、关联任务及费用。校验报告中的商品和证据属于当前账号有权访问的调查；失效引用不能输出为已查证结论。

## 4. 阶段任务清单

### Task 1：共用读取服务和工具（阶段 1）

- [x] 先在 `workbench/tests/integration/assistant-tools.test.ts` 加入商品 ID、分页、不同商品连续读取、缺资料、只读角色和跨账号任务拒绝用例。
- [x] 从 catalog 和 Amazon 路由提取只读查询，保持原 API JSON 字段及权限行为。
- [x] 建立工具 schema、结果契约和当前身份检查；`read_reviews` 只读已保存报告，`read_job` 先验证归属，再复用现有结果脱敏。
- [x] 在 `workbench/tests/e2e/assistant.spec.ts` 增加当前筛选、选中商品、切换页面后对象标识的检查。
- [x] 更新页面上下文，区分当前浏览对象与已经创建的调查对象；“这件”采用当前显示对象，“继续刚才”采用明确关联的调查。
- [x] 保留固定指令不调用模型的回归；验证读取工具没有外部采集副作用。

验证：`pnpm exec vitest run tests/integration/assistant.test.ts tests/integration/assistant-tools.test.ts packages/catalog/tests/routes.test.ts`。预期全部通过，返回 ID 可用于下一次详情读取，未授权任务返回无可见内容。

### Task 2：独立调查、持久循环和报告（阶段 2）

- [x] 新增调查和步骤迁移，不改变既有 job_runs.kind 的含义；旧对话仍可读取。
- [x] 在 `workbench/tests/integration/assistant-runs.test.ts` 定义状态、稳定动作、重复提交、当前角色和暂停取消用例。
- [x] 在 `workbench/tests/integration/assistant-loop.test.ts` 用预设模型响应完成“查列表→逐款详情→评论或竞品→报告”；验证第二次能调用相同工具读取另一款商品。
- [x] 实现循环，限制次数 / 用量；相同参数和证据版本不反复执行，明确翻页和用户刷新可生成新动作。
- [x] 模型调用接入现有 AI 服务队列及费用记录。发送前持久预留；响应归档后才算完成，未知费用不自动重发。
- [x] 新增 AssistantWorkflow 导出、binding 和类型；每个模型请求及工具动作使用独立稳定步骤键。不要把整个循环包成一个可重试步骤。
- [x] 实现结构化报告校验和模型不可用时的部分报告，在原对话展示运行状态与结果。
- [x] 扩展 `workbench/tests/integration/workflow-runtime.mjs`，验证真实本地 workerd 的步骤重放、页面关闭无影响、重复启动和取消落账。

验证：`pnpm exec vitest run tests/integration/assistant.test.ts tests/integration/assistant-tools.test.ts tests/integration/assistant-runs.test.ts tests/integration/assistant-loop.test.ts`、`pnpm test:workflow`。预期真实外部请求为 0，模拟多步调查和恢复通过。

阶段 2 完成标准：给定一批已有商品，不逐步提示，能完成比较与报告；预算或证据不足时有明确部分结果，不凭空补齐名单。

### Task 3：确认、在线工具和调查总额度（阶段 3）

- [ ] 在 `workbench/tests/integration/assistant-budget.test.ts` 先覆盖两项并发分配争抢最后额度、父子费用冲抵、重复确认、跨日、未知费用和管理员降低日预算。
- [ ] 新增 proposal 与任务关联，提交动作先持久化；使用稳定 requestId 调用现有 createJob，并核对当前身份及 scope_version。
- [ ] 将整次调查上限、子任务上限、团队日上限同时纳入检查。等待中的任务也占用已承诺额度。
- [ ] 评论模型总结通过统一预留、调用、归档、落账路径执行；保留积分与 AI 两种单位，失败不把预留当作已释放。
- [ ] 接通已有在线发现、商品更新、研究和 Amazon 补查；每个入口验证声明的作用与实际副作用一致。
- [ ] 为现有研究增加明确的分析 / 观察池写入选项；旧手动研究的默认行为兼容，新助手请求默认只分析。
- [ ] 在 `workbench/tests/integration/assistant-online.test.ts` 验证拒绝 / 过期 / 旧范围 proposal 无外部请求，已确认动作只提交一次。
- [ ] 增加子任务等待、部分失败、超时恢复及结果回收；以 D1 终态为依据，不靠模型重复查询进度。

验证：`pnpm exec vitest run tests/integration/assistant-budget.test.ts tests/integration/assistant-online.test.ts packages/operations/tests/jobs.test.ts`、`pnpm test:workflow`。预期并发不能突破上限；uncertain 不重发；模型可读取子任务结果继续调查。

真实小样验证前给出具体商品、动作、最多请求数、数据积分、AI 上限、环境和停止条件；按届时明确授权执行。模拟通过不能替代真实供应商合同验证。

### Task 4：追问归属、改条件和继续调查（阶段 4）

- [ ] 在 `workbench/tests/integration/assistant-followups.test.ts` 覆盖原任务补充、无关新目标、停止后消息、完成后继续和重复消息。
- [ ] 保存尚未处理的用户输入，在步骤边界按调查归属消费；不让新消息覆盖执行中的范围。
- [ ] 条件变更增加 scope_version，原 proposal 失效；在途请求可以完成落账，但不能授权新的超范围调用。
- [ ] 为后续调查保存报告版本和所用证据版本；旧结论保留并标记资料时间。
- [ ] 账号停用、降权和归属变更在下一步检查生效；后台恢复不使用过时角色快照。
- [ ] 浏览器覆盖进度查看、补充条件、取消和返回原对话；多运营延续现有公平派发规则。

验证：`pnpm exec vitest run tests/integration/assistant-followups.test.ts tests/integration/assistant-runs.test.ts`、`pnpm exec playwright test tests/e2e/assistant.spec.ts`。预期输入不丢失、不重复执行、不越权、不沿用失效授权。

### Task 5：业务方法和固定评估（阶段 5）

- [ ] 整理已批准规则到 playbook，引用已有确定性计算，不复制另一套潜力评级算法。
- [ ] 在 `workbench/tests/fixtures/assistant-evaluation.json` 保存脱敏样本和人工标签，覆盖数据不足、陈旧、规格不匹配、查无结果、查询失败及普通 Amazon / Haul 区别。
- [ ] 在 `workbench/tests/integration/assistant-evaluation.test.ts` 校验事实引用、范围、规则版本和报告结构；预设响应测试不宣称衡量模型智力。
- [ ] 人工反馈记录建议和依据，更新规则需要复核；变更保留版本并可回退。
- [ ] 需要比较模型自主调查质量时，另行限定相同模型、相同样本、相同工具和额度，人工盲评后决定是否推广。

验证：`pnpm exec vitest run tests/integration/assistant-evaluation.test.ts`。记录支持事实的结论数、关键缺口识别、无进展调用和费用；任何越权或未授权调用均不通过。

## 5. 全阶段验证和上线

命令从 `workbench/` 执行。新测试路径随对应阶段创建后才可运行，本文不声称它们已存在或已经通过。

受影响阶段交付前运行：

```powershell
pnpm typecheck
pnpm check:unused
pnpm check:style
pnpm test
pnpm build
pnpm check:workers
pnpm test:workflow
pnpm exec playwright test tests/e2e/assistant.spec.ts
```

`check:workers` 是已有脚本中的双 Worker dry-run，不是生产部署。测试先确认模拟上游和独立数据库；不得为了通过测试读取生产密钥。需要本地库迁移时按运行手册操作隔离库，不能直接修改日常开发库或生产库。

Windows 测试临时文件若遇到沙箱 EPERM，可只为当前测试进程设置项目内临时目录：

```powershell
New-Item -ItemType Directory -Force -Path '.local/investigation-temp' | Out-Null
$env:TEMP = Join-Path (Get-Location) '.local/investigation-temp'
$env:TMP = $env:TEMP
pnpm exec vitest run tests/integration/assistant.test.ts packages/operations/tests/jobs.test.ts
```

涉及 UI 的阶段还须遵守原项目多设备验收：直板手机、折叠外屏和内屏、16 / 24 / 27 英寸 PC 对应视口与缩放；记录实测或模拟环境，不能把桌面截图当成全部设备验收。

上线准备：新入口受配置开关控制，旧助手可回退；采用新增迁移，先在隔离环境演练。回退停止新调查启动并让在途请求完成落账，保留调查记录、费用和证据。生产部署及启用收费能力按执行时的授权办理。

## 6. 每阶段完成后更新什么

- [ ] 更新阶段总方案中的完成项与验收结果。
- [ ] 在本文件追加实际修改文件、验证命令、结果、限制和业务副作用。
- [ ] 更新 README 与需求待办，避免继续显示已经过期的状态。
- [ ] 记录代码验证、模拟上游验证和真实业务验证的区别。

建档时各阶段未实施；2026-11-01 后续执行已完成阶段 1、2，新增代码验收与发布结果见阶段总方案第 11 节。此前的 43 项隔离测试仅是旧基线记录。
