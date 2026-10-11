# v1 接口约定

JSON UTF-8。金额入参字符串，金额返回字段 `*_cents` 均整数。所有写操作请求头 `X-Ledger-Request: 1`，Content-Type application/json。错误 `{"detail":"中文说明"}`，输入错误 422、找不到 404、冲突 409。分页不做；硬限数据库业务和流水合计 10,000 条，达到上限拒绝新建，UI 提示导出归档。返回列表按 date desc、id desc。普通请求 10 MiB、恢复请求 128 MiB 上限。

## 单据

GET /api/entries -> {items: Entry[]}
POST /api/entries -> Entry (201)

销售入参 `{kind:"sale",date:"2026-10-01",description:"帆布袋",category:"商品",quantity:10,unit_price:"20.00",unit_cost:"8.00",note:"",external_id:"optional-import-id"}`。
费用入参 `{kind:"expense",date:"2026-10-02",description:"房租",category:"房租",amount:"2000.00",note:"",external_id:"..."}`。
销售与费用字段互斥；未知字段拒绝。description 1..120 字，category 1..40，note 0..500，external_id 若有 1..80，同库唯一，包括作废记录。
Entry: `{id,kind,date,description,category,quantity,unit_price_cents,unit_cost_cents,revenue_cents,cost_cents,amount_cents,note,external_id,created_at,voided_at,void_reason,received_cents,paid_cents}`。
id 为 UUID 字符串。销售 amount_cents=revenue_cents；费用 revenue/cost=0，quantity/unit价格为 null。received/paid 为所有有效关联流水累计（非筛选期）。
POST /api/entries/{id}/void `{reason:"录入有误"}` -> Entry。已有有效关联流水拒绝作废，重复作废 409。

## 流水

GET /api/payments -> {items: Payment[]}
POST /api/payments -> Payment (201)
`{kind:"receipt"|"cost_payment"|"expense_payment"|"capital_in"|"capital_out",entry_id:uuid|null,date,amount:"100.00",note:""}`。
前三种必须关联对应类型有效单据；日期不得早于单据日期；总已收/已付不能超过应收/应付；后两种禁止关联单据。金额 >0。cost_payment 对应销售直接成本，expense_payment 对应费用。receipt 收入、其余付款支出，capital_in收入、capital_out支出。
Payment `{id,kind,entry_id,date,amount_cents,note,created_at,voided_at,void_reason}`。
POST /api/payments/{id}/void `{reason}` -> Payment，重复作废409。

## 报表

GET /api/summary?start=2026-10-01&end=2026-10-31 ->
`{start,end,revenue_cents,cost_cents,gross_profit_cents,expense_cents,profit_cents,cash_in_cents,cash_out_cents,net_cash_cents,balance_cents,receivable_cents,payable_cents,monthly:[{month:"2026-10",revenue_cents,cost_cents,expense_cents,profit_cents,cash_in_cents,cash_out_cents}],entry_count}`。
start/end 必填，最多 366 天，均包含边界；monthly 只统计筛选范围内记录，空月补零。balance/receivable/payable 为截至 end 的累计值，忽略 start。

GET /api/meta -> `{name:"小本账",currency:"CNY",demo:boolean,entry_count,payment_count}` (counts包含作废)。
POST /api/demo `{}` -> `{ok:true}`，仅允许完全空库，生成当前本地月份虚构数据，meta.demo 持久化 true。

## 导入、导出与恢复

GET /api/export/entries.csv：UTF-8 BOM, columns `external_id,kind,date,description,category,quantity,unit_price,unit_cost,amount,note,status,text_encoding`。无external_id生成 `entry-{uuid}` 保证重导不重复。包含作废并标status，导入明确拒绝status=void。text_encoding=apostrophe-v1 标记本工具的公式防护格式：以公式符号或单引号起头的文本前置单引号；只有此标记存在时还原。手写/外部CSV无标记则原样保留单引号。
GET /api/export/payments.csv：仅供查看（不能导回），全流水包括状态，文本公式防护。
GET /api/import/template.csv：以上销售/费用导入表头和两行虚构模板，不含status也接受。
POST /api/import/preview `{csv_text}` -> `{rows:EntryInput[],count,errors:[{row,message}]}`；不写库。最多2,000行、2MiB。external_id 必填，文件内/已有库重复是错误。errors非空 rows=[] 防误导。
POST /api/import/commit `{csv_text}` -> `{imported:N}`；重新验证并原子提交，任何错误不导入，409或422。
GET /api/backup -> `{version:1,currency:"CNY",demo,exported_at,entries:[rawEntry],payments:[rawPayment]}`；raw不含派生received/paid，可包含。
POST /api/restore `{backup:Backup}` -> `{restored_entries:N,restored_payments:N}`，只允许完全空库，校验全部类型、id唯一、金额、关联、日期、作废状态，事务内整批恢复。保留id/created_at/voided_at/void_reason，禁止覆盖。

## Python 模块

`models.py` 验证输入，`store.py` 处理事务，`reports.py` 计算报表，`transfer.py` 导入与备份，`app.py` 提供 HTTP 接口。`create_app(db_path: str|Path|None=None)` 创建 app，默认 env LEDGER_DB_PATH 或 ./data/ledger.db；app.state.store 是 Store。
Store(path)，方法 entries(), payments(), create_entry(payload), create_payment(payload), void_entry(id,reason), void_payment(id,reason), summary(start,end), meta(), seed_demo() 返回上述dict；`connect()` contextmanager 提供 sqlite3 Connection，启用 FK、busy_timeout，row_factory。
store 模块提供 `LedgerError(detail,status_code=422)`。create_* 接收 dict 入参。迁移模块在 `with store.connect() as conn:` 内 `BEGIN IMMEDIATE`，使用 models 验证并在同一事务提交。SQL 表使用 Entry/Payment 原始字段命名；日期时间为 TEXT，整数分为 INTEGER；metadata(key TEXT PRIMARY KEY,value TEXT)。
生产静态资源从项目 frontend/dist 提供，未知 /api 返回404而不是前端首页。使用 loopback Host 白名单、Origin/Sec-Fetch-Site 校验、自定义请求头和 JSON content-type 写操作约束。普通请求限制10MiB，恢复请求128MiB。Vite proxy 127.0.0.1:8000 changeOrigin；开发 Origin 127.0.0.1:5173/localhost:5173 仅 LEDGER_DEV=1 时允许。
