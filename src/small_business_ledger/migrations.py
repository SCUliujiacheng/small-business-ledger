"""Transactional migration from the original ledger schema; never downgrade."""

SCHEMA_VERSION = 2


def migrate(conn, before_write):
    conn.execute("BEGIN IMMEDIATE")
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version == SCHEMA_VERSION:
        return
    if version not in {0, 1}:
        raise ValueError("数据库版本高于或不兼容当前程序，请使用匹配的版本打开")
    columns = {r[1] for r in conn.execute("PRAGMA table_info(entries)")}
    required = {
        "id",
        "kind",
        "date",
        "description",
        "category",
        "quantity",
        "unit_price_cents",
        "unit_cost_cents",
        "revenue_cents",
        "cost_cents",
        "amount_cents",
        "note",
        "external_id",
        "created_at",
        "voided_at",
        "void_reason",
    }
    if columns != required:
        raise ValueError("旧账本结构不受支持，请保留原文件并使用匹配的程序")
    before_write(conn)
    for definition in [
        "customer TEXT NOT NULL DEFAULT ''",
        "supplier TEXT NOT NULL DEFAULT ''",
        "receivable_due_date TEXT",
        "payable_due_date TEXT",
    ]:
        conn.execute("ALTER TABLE entries ADD COLUMN " + definition)
    conn.execute("""CREATE TABLE write_requests (
        key TEXT PRIMARY KEY, operation TEXT NOT NULL, payload_hash TEXT NOT NULL,
        record_id TEXT NOT NULL UNIQUE
    )""")
    conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
