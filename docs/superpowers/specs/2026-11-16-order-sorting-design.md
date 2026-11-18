# ERP 订单分拣

用户授权：按已核验的 LENI 脚本与产品属性清单接入 ERP；明确选择 ERP 维护清单并支持导入/导出。现有库存自动补库仍暂停，此模块与库存执行隔离。

## 行为

上传 Order List xlsx，严格使用 A4 日期、第6行表头、第7行起明细。匹配、关键词次序、兜底分类、SKU/FNSKU汇总、属性自动补录全部对齐 outputs/leni-static-analysis/sort_orders.py。保留原脚本正负/小数数量行为，不擅加业务条件；输入类型、长度、文件大小由接口明确校验。未知商品仍进入待确认，未知属性留空。没有去重 Transfer Id 的新规则。

管理员维护产品属性与模板；运营及管理员执行分拣；已登录只读角色可以查看结果和下载。初始清单172条、模板来自用户给定共享盘，作为ERP初始版本导入，之后不自动回写NAS。管理员可编辑A-K列、导入替换并导出，版本不匹配阻止覆盖。

分拣预览不写数据；生成时服务端重新按当前版本计算。分组输出名称仍为组名-YYMMDD.xlsx，订单明细+原始订单两页，模板样式和公式保留。全部分组可打包ZIP，历史运行可重新下载。属性清单自动补录结果保存在ERP，随时导出。

同日期同分组单元格内容完全相同允许复用，不同内容拦截整批，避免前半批成功后半批失败。请求ID负责网络重试幂等；配置版本CAS防止多个电脑同时覆盖属性。版本、输入与结果保留用于追溯。

## 实现

packages/order-sorting/rules.ts：无I/O纯逻辑，输入二维属性表及规范化订单，输出分组明细与更新后属性表。workbook.ts：ExcelJS浏览器延迟加载，读取xlsx、按模板生成xlsx和ZIP，避免Workers运行Python或直接访问共享盘。

packages/order-sorting/service.ts/routes.ts：Hono会话权限、D1版本CAS、分拣记录、同名冲突，R2私有存储原始属性表/模板。服务端使用纯规则重新分类，并在管理员导入模板时用 ExcelJS 原生文档入口计算保留单元格内容指纹；Workers 构建将 readable-stream 映射到原生 node:stream，避免浏览器适配层跨请求失效及输出调试内容。客户端预览不能授权服务器最终分类。新增0049迁移，独立表不触碰库存表。

apps/web/src/order-sorting.tsx：左侧一级“订单分拣”，上传预览、生成下载、历史记录、管理员清单/模板管理。复用ERP现有UI样式。

## 稳定接口

Cell = string | number | boolean | null；AttributeRow = Cell[]（固定11列）；OrderRow = [Cell,string,string,string,number]。
OrderInput = {date:string,rows:OrderRow[]}。
SortPlan = {date:string,groups:SortGroup[],attributes:AttributeRow[],additions:{code:string,sku:string,group:string|null}[],filled:number,totalRows:number,totalUnits:number}。
SortGroup = {name:string,filename:string,raw:OrderRow[],detail:Cell[][],units:number}。detail每行14列、含公式字符串，与Python生成的第4行起数据等价。
sortOrders(order:OrderInput,attributes:AttributeRow[]):SortPlan；specificGroup/productCode/matchAttribute导出便于测试。
workbook函数 parseOrder(bytes):Promise<OrderInput>，parseAttributes(bytes):Promise<{rows:AttributeRow[]}>，validateTemplate(bytes):Promise<void>，exportGroup(templateBytes,group,date):Promise<Uint8Array>，exportAttributes(originalBytes,rows):Promise<Uint8Array>，exportZip(templateBytes,plan):Promise<Uint8Array>。

API GET /order-sorting/state -> {config:null|{revision,rows,attributeKey,templateKey,updatedAt},runs:RunSummary[]}。
POST /order-sorting/config 管理员：{revision:number,rows:AttributeRow[],attributeFile?:{name,base64},templateFile?:{name,base64}}，revision=0只允许首次导入，文件仅初始或替换上传。编辑只提交rows。
POST /order-sorting/preview 运营：{revision,order} -> SortPlan。
POST /order-sorting/run 运营：{id:uuid,revision,filename,order} -> RunResult。
GET /order-sorting/runs/:id -> RunResult。
GET /order-sorting/history?time=毫秒&id=UUID -> {runs,next}，按时间和UUID游标翻页，每页30批，可查看和下载更早记录。
GET /order-sorting/assets/:key -> 私有xlsx，key只允许本模块D1登记的资产。
RunResult = {id,createdAt,filename,revision,attributeKey,templateKey,plan:SortPlan}；RunSummary={id,createdAt,filename,date,groups,rows,units}。

原始XLSX和模板用base64传输且限制大小，转换函数须不打印文件内容。D1统一配置快照保留11列空行（原首行标题由workbook模块管理，不在rows里），run事务更新配置、登记同名文件hash和保存结果。源配置与结果只出现在登录API，不公开打包到静态站点。

## 验证

先建立测试复现精确SKU优先、最长前缀、冲突、关键词顺序、原始SKU合并、未知产品补录等。用Python原脚本在本地临时目录运行合成订单，逐格对比TS导出结果及属性补录。生产共享盘仅复制读取。测试权限、并发版本、同名冲突、网络重试、重下历史结果。浏览器临时环境验证上传/预览/导出/清单编辑。生产初始化仅导入配置，不创建真实订单分拣，不影响库存开关。
