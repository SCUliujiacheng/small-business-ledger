# 0.2 版接口与数据格式

JSON UTF-8。金额入参字符串，金额返回字段 `*_cents` 均整数。所有写操作请求头 `X-Ledger-Request: 1`，Content-Type application/json。错误 `{"detail":"中文说明"}`，输入错误 422、找不到 404、冲突 409、自动备份失败 503。分页不做；硬限数据库业务和流水合计 10,000 条，达到上限拒绝新建，导出不会释放容量。返回列表按 date desc、id desc。普通请求 10 MiB、恢复请求 128 MiB 上限。

`POST /api/entries` 和 `POST /api/payments` 支持可选 `Idempotency-Key` 标准小写 UUID 请求头。网页默认使用；第三方调用不带此头时没有请求去重保证。同一编号、同一规范化内容重试返回同一记录的当前状态（仍为 201），跨操作或修改内容返回 409。请求索引与记录同时提交，失败不占用编号；作废后重试返回已作废记录，不重建。索引随版本 2 JSON 备份保存。

## 单据

GET /api/entries -> {items: Entry[]}
POST /api/entries -> Entry (201)

销售入参 `{kind:"sale",date:"2026-10-01",description:"帆布袋",category:"商品",quantity:10,unit_price:"20.00",unit_cost:"8.00",note:"",external_id:"optional-import-id"}`。
费用入参 `{kind:"expense",date:"2026-10-02",description:"房租",category:"房租",amount:"2000.00",note:"",external_id:"..."}`。
销售与费用字段互斥；未知字段拒绝。description 1..120 字，category 1..40，note 0..500，external_id 若有 1..80，同库唯一，包括作废记录。
Entry: `{id,kind,date,description,category,quantity,unit_price_cents,unit_cost_cents,revenue_cents,cost_cents,amount_cents,note,external_id,created_at,voided_at,void_reason,received_cents,paid_cents}`。
0.2 增加可选入参、固定返回字段：`customer`、`supplier`（0..120 字，默认空字符串），`receivable_due_date`、`payable_due_date`（ISO 日期或 null，默认 null，不能早于业务日期）。费用不接受非空客户和收款到期日；一条销售分别关联一个客户和一个成本收款方。
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

GET /api/outstanding?as_of=2026-10-31 -> `{as_of,receivable_cents,payable_cents,overdue_receivable_cents,overdue_payable_cents,items}`。每项 `{entry_id,kind,date,description,category,counterparty,due_date,original_cents,settled_cents,outstanding_cents,overdue_days,status}`；kind 为 receipt、cost_payment 或 expense_payment。按到期日、业务日、记录编号和类型排序，无到期日排后面。只统计截止日前有效业务和有效流水，结清项不返回。status 为 overdue、due_today、upcoming、no_due_date；逾期严格指到期日早于截止日。合计是全表，不是网页筛选合计。

GET /api/export/outstanding.csv?as_of=... 下载此截止日全部欠款，不跟随网页收付方向、检索和逾期筛选。文本做公式防护，文件仅供查阅，不能作为恢复备份。

GET /api/meta -> `{name:"小本账",currency:"CNY",demo:boolean,entry_count,payment_count}` (counts包含作废)。
POST /api/demo `{}` -> `{ok:true}`，仅允许完全空库，生成当前本地月份虚构数据，meta.demo 持久化 true。

## 导入、导出与恢复

GET /api/export/entries.csv：UTF-8 BOM, columns `external_id,kind,date,description,category,quantity,unit_price,unit_cost,amount,note,customer,supplier,receivable_due_date,payable_due_date,status,text_encoding`。无external_id生成 `entry-{uuid}` 保证重导不重复。包含作废并标status，导入明确拒绝status=void。text_encoding=apostrophe-v1 标记本工具的公式防护格式：以公式符号或单引号起头的文本前置单引号；只有此标记存在时还原。手写/外部CSV无标记则原样保留单引号。
旧表头仍可导入，缺失的四个往来/到期字段填默认值。客户和供应商名称同样做公式转义。
GET /api/export/payments.csv：仅供查看（不能导回），全流水包括状态，文本公式防护。
GET /api/import/template.csv：以上销售/费用导入表头和两行虚构模板，不含status也接受。
POST /api/import/preview `{csv_text}` -> `{rows:EntryInput[],count,errors:[{row,message}]}`；不写库。最多2,000行、2MiB。external_id 必填，文件内/已有库重复是错误。errors非空 rows=[] 防误导。
POST /api/import/commit `{csv_text}` -> `{imported:N}`；重新验证并原子提交，任何错误不导入，409或422。
GET /api/backup -> `{version:2,currency:"CNY",demo,exported_at,entries:[rawEntry],payments:[rawPayment],write_requests:[{key,operation,payload_hash,record_id}]}`。导出的原始单据不带 received_cents 和 paid_cents；恢复兼容带有这两个字段的数据，但丢弃其值，余额仍从有效流水重新计算。请求索引最多与记录一样多，operation 为 entry.create 或 payment.create，payload_hash 为 64 位小写十六进制 SHA-256，key 和 record_id 唯一且关联类型匹配。
恢复会从关联记录重建规范化创建请求，并核对 payload_hash；只满足格式但与记录内容不符的摘要会被拒绝。摘要用于校验关联一致性，不是数字签名或防篡改凭证。
POST /api/restore `{backup:Backup}` -> `{restored_entries:N,restored_payments:N}`，只允许完全空库，校验全部类型、id唯一、金额、关联、日期、作废状态，事务内整批恢复。保留id/created_at/voided_at/void_reason，禁止覆盖。
恢复同时接受旧版本 1（没有 write_requests 和往来字段），自动补默认值。迁移前生成的旧格式快照仍可由旧版程序恢复。

## 本机快照

GET /api/local-backups -> `{directory,retention:30,items:[{filename,created_at,size_bytes}]}`，最新在前。POST 同一路径 `{}` 立即生成当前快照，201 返回单项信息。GET /api/local-backups/{filename} 下载已校验的 JSON，只允许工具命名的普通文件，不接受任意路径或符号链接。

每次改变非空账本前，在写事务内读取一致状态生成快照；写入、校验、刷盘与原子发布成功后才继续改账。生成失败返回 503，账目不变。目录固定为数据库文件名加 `.backups`，保留最近 30 份，备份是变更前状态。备份不加密，也不是异地备份。

## Python 模块

`models.py` 验证输入，`store.py` 处理事务，`reports.py` 计算报表，`transfer.py` 导入与备份，`app.py` 提供 HTTP 接口。`create_app(db_path: str|Path|None=None)` 创建 app，默认 env LEDGER_DB_PATH 或 ./data/ledger.db；app.state.store 是 Store。
Store(path)，方法 entries(), payments(), create_entry(payload,request_id=None), create_payment(payload,request_id=None), void_entry(id,reason), void_payment(id,reason), summary(start,end), outstanding(as_of), meta(), seed_demo(), local_backups(), snapshot_now(), read_snapshot(filename) 返回上述dict；`connect()` contextmanager 提供 sqlite3 Connection，启用 FK、busy_timeout，row_factory。
store 模块提供 `LedgerError(detail,status_code=422)`。create_* 接收 dict 入参。迁移模块在 `with store.connect() as conn:` 内 `BEGIN IMMEDIATE`，使用 models 验证并在同一事务提交。SQL 表使用 Entry/Payment 原始字段命名；日期时间为 TEXT，整数分为 INTEGER；metadata(key TEXT PRIMARY KEY,value TEXT)。
生产静态资源从项目 frontend/dist 提供，未知 /api 返回404而不是前端首页。使用 loopback Host 白名单、Origin/Sec-Fetch-Site 校验、自定义请求头和 JSON content-type 写操作约束。普通请求限制10MiB，恢复请求128MiB。Vite proxy 127.0.0.1:8000 changeOrigin；开发 Origin 127.0.0.1:5173/localhost:5173 仅 LEDGER_DEV=1 时允许。
