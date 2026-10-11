"""Transactional SQLite storage. All writes lock before checking related balances."""

import sqlite3
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from uuid import uuid4

from .models import MAX_RECORDS, ValidationError, validate_entry, validate_payment, validate_text
from .reports import summarize


class LedgerError(ValueError):
    def __init__(self, detail, status_code=422):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def timestamp():
    return datetime.now(UTC).isoformat()


class Store:
    def __init__(self, path):
        self.path = str(Path(path).resolve())
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sale','expense')),
                    date TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
                    quantity INTEGER, unit_price_cents INTEGER, unit_cost_cents INTEGER,
                    revenue_cents INTEGER NOT NULL CHECK(revenue_cents >= 0),
                    cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),
                    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
                    note TEXT NOT NULL, external_id TEXT UNIQUE, created_at TEXT NOT NULL,
                    voided_at TEXT, void_reason TEXT
                );
                CREATE TABLE IF NOT EXISTS payments (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL CHECK(kind IN ('receipt','cost_payment','expense_payment','capital_in','capital_out')),
                    entry_id TEXT REFERENCES entries(id), date TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), note TEXT NOT NULL,
                    created_at TEXT NOT NULL, voided_at TEXT, void_reason TEXT
                );
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
                CREATE INDEX IF NOT EXISTS entries_date_idx ON entries(date);
                CREATE INDEX IF NOT EXISTS payments_entry_idx ON payments(entry_id, kind);
                CREATE INDEX IF NOT EXISTS payments_date_idx ON payments(date);
            """)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def _capacity(conn):
        count = conn.execute(
            "SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM payments)"
        ).fetchone()[0]
        if count >= MAX_RECORDS:
            raise LedgerError("账本已达到 10,000 条上限，请先导出归档", 409)

    @staticmethod
    def _entry(conn, entry_id):
        row = conn.execute(
            """
            SELECT e.*,
                COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                    WHERE p.entry_id=e.id AND p.kind='receipt' AND p.voided_at IS NULL),0) received_cents,
                COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                    WHERE p.entry_id=e.id AND p.kind IN ('cost_payment','expense_payment')
                        AND p.voided_at IS NULL),0) paid_cents
            FROM entries e WHERE e.id=?
        """,
            (entry_id,),
        ).fetchone()
        if row is None:
            raise LedgerError("未找到该单据", 404)
        return dict(row)

    def entries(self):
        with self.connect() as conn:
            conn.execute("BEGIN")
            ids = conn.execute("SELECT id FROM entries ORDER BY date DESC,id DESC").fetchall()
            return [self._entry(conn, item["id"]) for item in ids]

    def payments(self):
        with self.connect() as conn:
            return [
                dict(row)
                for row in conn.execute("SELECT * FROM payments ORDER BY date DESC,id DESC")
            ]

    def insert_entry(self, conn, validated):
        if not conn.in_transaction:
            raise RuntimeError("insert_entry requires an active write transaction")
        self._capacity(conn)
        row = {
            "id": str(uuid4()),
            **validated,
            "created_at": timestamp(),
            "voided_at": None,
            "void_reason": None,
        }
        try:
            columns = ",".join(row)
            conn.execute(
                f"INSERT INTO entries ({columns}) VALUES ({','.join('?' for _ in row)})",
                tuple(row.values()),
            )
        except sqlite3.IntegrityError as exc:
            raise LedgerError("外部编号重复或单据约束不满足", 409) from exc
        return self._entry(conn, row["id"])

    def create_entry(self, payload):
        try:
            validated = validate_entry(payload)
        except ValidationError as exc:
            raise LedgerError(str(exc)) from exc
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            return self.insert_entry(conn, validated)

    def insert_payment(self, conn, validated):
        if not conn.in_transaction:
            raise RuntimeError("insert_payment requires an active write transaction")
        self._capacity(conn)
        if validated["entry_id"] is not None:
            entry = self._entry(conn, validated["entry_id"])
            if entry["voided_at"]:
                raise LedgerError("不能关联已作废单据", 409)
            kind = validated["kind"]
            expected = "expense" if kind == "expense_payment" else "sale"
            if entry["kind"] != expected:
                raise LedgerError("流水类型与单据类型不匹配")
            if validated["date"] < entry["date"]:
                raise LedgerError("收付款日期不能早于单据日期")
            limit_field = {
                "receipt": "revenue_cents",
                "cost_payment": "cost_cents",
                "expense_payment": "amount_cents",
            }[kind]
            used = conn.execute(
                "SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE entry_id=? AND kind=? AND voided_at IS NULL",
                (entry["id"], kind),
            ).fetchone()[0]
            if used + validated["amount_cents"] > entry[limit_field]:
                raise LedgerError("本次金额超过剩余应收或应付金额", 409)
        row = {
            "id": str(uuid4()),
            **validated,
            "created_at": timestamp(),
            "voided_at": None,
            "void_reason": None,
        }
        columns = ",".join(row)
        conn.execute(
            f"INSERT INTO payments ({columns}) VALUES ({','.join('?' for _ in row)})",
            tuple(row.values()),
        )
        return row

    def create_payment(self, payload):
        try:
            validated = validate_payment(payload)
        except ValidationError as exc:
            raise LedgerError(str(exc)) from exc
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            return self.insert_payment(conn, validated)

    def _void(self, table, record_id, reason):
        try:
            reason = validate_text(reason, "作废原因", 1, 500)
        except ValidationError as exc:
            raise LedgerError(str(exc)) from exc
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (record_id,)).fetchone()
            if row is None:
                raise LedgerError("未找到该记录", 404)
            if row["voided_at"]:
                raise LedgerError("该记录已经作废", 409)
            if (
                table == "entries"
                and conn.execute(
                    "SELECT 1 FROM payments WHERE entry_id=? AND voided_at IS NULL LIMIT 1",
                    (record_id,),
                ).fetchone()
            ):
                raise LedgerError("请先作废该单据关联的有效收付款流水", 409)
            conn.execute(
                f"UPDATE {table} SET voided_at=?,void_reason=? WHERE id=?",
                (timestamp(), reason, record_id),
            )
            return (
                self._entry(conn, record_id)
                if table == "entries"
                else dict(
                    conn.execute("SELECT * FROM payments WHERE id=?", (record_id,)).fetchone()
                )
            )

    def void_entry(self, entry_id, reason):
        return self._void("entries", entry_id, reason)

    def void_payment(self, payment_id, reason):
        return self._void("payments", payment_id, reason)

    def summary(self, start, end):
        with self.connect() as conn:
            conn.execute("BEGIN")
            entries = [dict(row) for row in conn.execute("SELECT * FROM entries")]
            payments = [dict(row) for row in conn.execute("SELECT * FROM payments")]
        try:
            return summarize(entries, payments, start, end)
        except ValidationError as exc:
            raise LedgerError(str(exc)) from exc

    def meta(self):
        with self.connect() as conn:
            conn.execute("BEGIN")
            flag = conn.execute("SELECT value FROM metadata WHERE key='demo'").fetchone()
            return {
                "name": "小本账",
                "currency": "CNY",
                "demo": bool(flag and flag[0] == "true"),
                "entry_count": conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0],
                "payment_count": conn.execute("SELECT COUNT(*) FROM payments").fetchone()[0],
            }

    def seed_demo(self):
        month = date.today().strftime("%Y-%m")
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute(
                "SELECT (SELECT COUNT(*) FROM entries)+(SELECT COUNT(*) FROM payments)"
            ).fetchone()[0]:
                raise LedgerError("示例只能装入完全空白的账本", 409)
            sale = self.insert_entry(
                conn,
                validate_entry(
                    {
                        "kind": "sale",
                        "date": month + "-01",
                        "description": "示例：帆布袋",
                        "category": "商品",
                        "quantity": 25,
                        "unit_price": "48",
                        "unit_cost": "18",
                        "note": "虚构示例，非真实经营数据",
                        "external_id": "demo-sale-1",
                    }
                ),
            )
            expense = self.insert_entry(
                conn,
                validate_entry(
                    {
                        "kind": "expense",
                        "date": month + "-02",
                        "description": "示例：摊位租金",
                        "category": "租金",
                        "amount": "200",
                        "note": "虚构示例，非真实经营数据",
                        "external_id": "demo-expense-1",
                    }
                ),
            )
            for kind, entry_id, amount, day in [
                ("capital_in", None, "1000", "01"),
                ("receipt", sale["id"], "900", "02"),
                ("cost_payment", sale["id"], "450", "02"),
                ("expense_payment", expense["id"], "200", "02"),
            ]:
                self.insert_payment(
                    conn,
                    validate_payment(
                        {
                            "kind": kind,
                            "entry_id": entry_id,
                            "date": month + "-" + day,
                            "amount": amount,
                            "note": "虚构示例",
                        }
                    ),
                )
            conn.execute(
                "INSERT INTO metadata(key,value) VALUES ('demo','true') ON CONFLICT(key) DO UPDATE SET value='true'"
            )
        return {"ok": True}
