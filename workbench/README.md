# 自动选品工作台

在本机查看 [商品发现](http://127.0.0.1:8787/)，或打开 [Temu 美国家居首轮筛选](http://127.0.0.1:8787/?platform=temu&category=temu%3A9711&maxPrice=4&tier=50k)。本地入口需要开发服务运行。

云端使用 [工作台登录页](https://xuanpin.gy1207981728.workers.dev/login)。所有者第一次打开[管理员开户页](https://xuanpin.gy1207981728.workers.dev/api/auth/setup)，验证邮箱后设置自己的用户名和密码，再在工作台给成员分配账号和角色。

每个账号可在「个人设置」调整默认视图与每页商品数量，在「发现商品 → 我的预设」保存和应用选品条件。商品详情分析、AI 差评和后续 ERP 模块的调研记录见[需求待办](docs/需求待办.md)。

## 启动与停止

在本目录使用 Node 24、Python 3 和 pnpm 11.25。首次运行依次执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm db:local
pnpm dev
```

下次直接运行 `pnpm dev`。前端代码修改后运行 `pnpm build`。需要应用数据库迁移时先运行 `pnpm stop`，再运行 `pnpm db:local` 和 `pnpm dev`。工作台数据保存在忽略提交的 `.local/state` 下。浏览器端只加载当前页。

## 主管可以复核什么

- **商品发现**。22,664 件美国站商品。点击“应用当前策略”，可组合平台、类目、美元价格、销量、时间、缺失状态与排序，再切换图片或表格视图。
- **商品详情**。可同时核对来源快照、历史、SKU 和人工反馈。初始缓存覆盖 125 件有历史的商品，包含 2,771 条去重观测。其余商品仍可查看已取得的快照。
- **候选与观察池**。标品和差异化/POD 可以同时选择。人员每次修改保留作者、日期与理由。模型产生的观察建议带模型署名并保留既有人工处理。
- **AI 研究台**。选择缓存模式即可按名称、链接或已选商品创建研究计划、查看实际范围与缺口。可附私有参考图，并人工指定对应商品。在线研究使用独立的 Decisions 分流和 Terra 报告调用。
- **任务中心**。查看缓存计划、发现页覆盖、重复与达标数、销量分层、证据、错误和费用。在线发现按已授权策略生成分层待研究清单。自动提交的商品数由策略和预算共同限定。
- **Amazon 对照**。配置 SP-API 后测试美国站目录权限，按关键词/ASIN 检索，续取可用分页，再依据规格确认匹配并读取可用报价。请求失败、空页、排名和未取得报价各自标识。Haul 共用 Amazon SP-API 连接。

## 后台与验收

页面和操作流程变更须按[项目开发基线的多设备验收要求](../docs/review-v0.1/02-项目开发基线.md)覆盖直板手机、折叠外屏与内屏，以及 16、24、27 英寸 PC。

API 和 Jobs 是两个 Cloudflare Worker，共用 D1。首次管理员开户验证所有者的 Access JWT，日常使用验证账号会话、应用角色与写操作来源。Jobs 使用 Workflows，R2 留存按步骤索引的证据。每日在线调度和新外部消耗默认关闭。

[运行手册和真实账号配置步骤](docs/运行与配置.md) 包含本地启动、独立预发布与生产资源、服务端凭据、预算和真实联调顺序。根目录探测数据不在网页构建范围内。

```powershell
pnpm typecheck
pnpm check:unused
pnpm check:style
pnpm test
python -m unittest discover -s packages/catalog/tests -p "*_test.py"
pnpm build
pnpm check:workers
pnpm test:workflow
pnpm test:e2e
```

`test:workflow` 使用本地 workerd 运行 API、Jobs、Workflow、D1、R2 及签名测试身份，拦截所有上游请求。`test:e2e` 在另一个回环端口和独立测试库中写入带 E2E 标识的反馈和任务。Windows 默认选用已安装的 Edge，也可指定 `PLAYWRIGHT_BROWSER_PATH`。启动常规服务后可运行 `node scripts/verify-pages.mjs` 重做六页与手机截图和首屏耗时测量。


## 本轮验证记录

2026-10-31，北京时间。本轮通过 TypeScript、Knip、Ultracite、前端构建、双 Worker 构建与运行时集成、41 项 Vitest 和 26 项 Playwright 回归。覆盖管理员开户、成员密码登录、职位与权限隔离、个人预设、商品平台标志，以及中美时钟在跨日和夏令时的显示。

浏览器实测了筛选与翻页后返回、19 条真实历史、候选双标签与反馈、零费用指定商品研究、刷新任务进度、只读连接状态和手机导航。用最终构建查看六个桌面页面及 390 像素手机布局。20 次本机请求，每页 50 件，列表 P95 为 27.1 毫秒。20 个全新浏览器上下文中，从访问到首个商品可操作，P95 为 342.4 毫秒。截图存于 .local/visual/。

本机开发库调度关闭，积分预算、AI 预算和自动研究上限均为 0。开发库的候选与任务由日常使用产生，E2E 测试写入独立库。云端已导入相同的 22,664 件商品和 2,771 条历史观测。生产每日实际触发、真实模型账单和 Amazon 授权仍待启用相关服务后验收。
