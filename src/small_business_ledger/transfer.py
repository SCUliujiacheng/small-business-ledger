"""CSV transfer and complete, non-destructive JSON backups."""

import csv
import io
import re
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from .models import (
    MAX_AMOUNT_CENTS,
    MAX_RECORDS,
    ValidationError,
    validate_entry,
    validate_payment,
    validate_text,
    validate_uuid,
)
from .store import LedgerError, timestamp

router = APIRouter(prefix="/api")
CSV_LIMIT = 2 * 1024 * 1024
CSV_ROWS = 2000
FIELDS = [
    "external_id",
    "kind",
    "date",
    "description",
    "category",
    "quantity",
    "unit_price",
    "unit_cost",
    "amount",
    "note",
]
ENTRY_COLUMNS = [
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
]
PAYMENT_COLUMNS = [
    "id",
    "kind",
    "entry_id",
    "date",
    "amount_cents",
    "note",
    "created_at",
    "voided_at",
    "void_reason",
]


def money(cents):
    return f"{cents // 100}.{cents % 100:02d}"


def _protect(value):
    text = str(value) if value is not None else ""
    if text.lstrip().startswith(("=", "+", "-", "@", "'")) or text.startswith(("\t", "\r", "\n")):
        return "'" + text
    return text


def _unprotect(text):
    # Only called for explicitly marked exports, never arbitrary external CSV.
    if text.startswith("'") and _protect(text[1:]) == text:
        return text[1:]
    return text


def _parse_csv(text, existing):
    errors, rows, seen = [], [], set(existing)
    try:
        valid_size = isinstance(text, str) and len(text.encode("utf-8")) <= CSV_LIMIT
    except UnicodeEncodeError:
        return {
            "rows": [],
            "count": 0,
            "errors": [{"row": 0, "message": "CSV 包含无效 Unicode 字符"}],
        }
    if not valid_size:
        return {"rows": [], "count": 0, "errors": [{"row": 0, "message": "CSV 不能超过 2 MiB"}]}
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff"), newline=""), strict=True)
        header = reader.fieldnames or []
        if (
            len(set(header)) != len(header)
            or not set(FIELDS) <= set(header)
            or set(header) - set(FIELDS + ["status", "text_encoding"])
        ):
            raise ValueError("表头不匹配，请使用下载的 CSV 模板")
        for index, row in enumerate(reader, 2):
            if index > CSV_ROWS + 1:
                raise ValueError("每次最多导入 2,000 行")
            try:
                if None in row or any(v is None for v in row.values()):
                    raise ValueError("列数不匹配")
                if row.get("status", "active") != "active":
                    raise ValueError("作废记录不能导入，请使用 JSON 备份恢复历史")
                encoding = row.get("text_encoding", "")
                if encoding not in {"", "apostrophe-v1"}:
                    raise ValueError("不支持的文本编码标记")
                if encoding == "apostrophe-v1":
                    row = {k: _unprotect(v) for k, v in row.items()}
                external = validate_text(row["external_id"], "外部编号", 1, 80)
                if external in seen:
                    raise ValueError("外部编号重复（文件内或账本已有）")
                seen.add(external)
                payload = {
                    k: row[k]
                    for k in ("kind", "date", "description", "category", "note", "external_id")
                }
                if row["kind"] == "sale":
                    if not re.fullmatch(r"[0-9]{1,7}", row["quantity"]):
                        raise ValueError("数量须为整数")
                    if row["amount"]:
                        raise ValueError("销售行的 amount 列应留空")
                    payload.update(
                        quantity=int(row["quantity"]),
                        unit_price=row["unit_price"],
                        unit_cost=row["unit_cost"],
                    )
                else:
                    if any(row[k] for k in ("quantity", "unit_price", "unit_cost")):
                        raise ValueError("费用行的数量、单价、单位成本应留空")
                    payload["amount"] = row["amount"]
                validate_entry(payload)
                rows.append(payload)
            except (ValueError, TypeError) as exc:
                errors.append({"row": index, "message": str(exc)})
        if not rows and not errors:
            errors.append({"row": 0, "message": "CSV 没有数据行"})
    except (ValueError, csv.Error) as exc:
        errors.append({"row": 0, "message": str(exc)})
    return {
        "rows": [] if errors else rows,
        "count": len(rows) if not errors else 0,
        "errors": errors,
    }


def preview_csv(store, text):
    with store.connect() as conn:
        existing = _existing_ids(conn)
    return _parse_csv(text, existing)


def _existing_ids(conn):
    # Manual entries also have a stable exported ID. Reimporting our own export
    # into the source ledger must not create a second copy of those entries.
    return [
        r["external_id"] or "entry-" + r["id"]
        for r in conn.execute("SELECT id,external_id FROM entries")
    ]


def commit_csv(store, text):
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = _existing_ids(conn)
        preview = _parse_csv(text, existing)
        if preview["errors"]:
            error = preview["errors"][0]
            raise LedgerError(f"第 {error['row']} 行：{error['message']}")
        for row in preview["rows"]:
            store.insert_entry(conn, validate_entry(row))
    return {"imported": preview["count"]}


def _csv_output(fields, rows):
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)
    return "\ufeff" + buffer.getvalue()


def export_entries(store):
    rows = []
    for e in store.entries():
        row = {k: _protect(e[k]) for k in ("kind", "date", "description", "category", "note")}
        row.update(
            external_id=_protect(e["external_id"] or "entry-" + e["id"]),
            quantity=e["quantity"] if e["kind"] == "sale" else "",
            unit_price=money(e["unit_price_cents"]) if e["kind"] == "sale" else "",
            unit_cost=money(e["unit_cost_cents"]) if e["kind"] == "sale" else "",
            amount=money(e["amount_cents"]) if e["kind"] == "expense" else "",
            status="void" if e["voided_at"] else "active",
            text_encoding="apostrophe-v1",
        )
        rows.append(row)
    return _csv_output(FIELDS + ["status", "text_encoding"], rows)


def export_payments(store):
    fields = ["id", "kind", "entry_id", "date", "amount", "note", "status", "void_reason"]
    rows = []
    for p in store.payments():
        row = {k: _protect(p[k]) for k in ("id", "kind", "entry_id", "date", "note", "void_reason")}
        row.update(amount=money(p["amount_cents"]), status="void" if p["voided_at"] else "active")
        rows.append(row)
    return _csv_output(fields, rows)


def make_backup(store):
    # One read transaction gives a consistent pair of tables, even while writes happen.
    with store.connect() as conn:
        conn.execute("BEGIN")
        entries = [dict(row) for row in conn.execute("SELECT * FROM entries ORDER BY date,id")]
        payments = [dict(row) for row in conn.execute("SELECT * FROM payments ORDER BY date,id")]
        demo = conn.execute("SELECT value FROM metadata WHERE key='demo'").fetchone()
    return {
        "version": 1,
        "currency": "CNY",
        "demo": bool(demo and demo[0] == "true"),
        "exported_at": timestamp(),
        "entries": entries,
        "payments": payments,
    }


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 40 or "T" not in value:
        raise ValidationError("时间戳格式无效")
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError
        return parsed
    except ValueError as exc:
        raise ValidationError("时间戳必须包含时区") from exc


def _audit_fields(row):
    validate_uuid(row["id"])
    created = _timestamp(row["created_at"])
    if row["voided_at"] is None:
        if row["void_reason"] is not None:
            raise ValidationError("有效记录不能有作废原因")
    else:
        if _timestamp(row["voided_at"]) < created:
            raise ValidationError("作废时间不能早于创建时间")
        validate_text(row["void_reason"], "作废原因", 1, 500)


def _cents(value):
    if type(value) is not int or not 0 <= value <= MAX_AMOUNT_CENTS:
        raise ValidationError("备份金额必须是范围内的整数分")
    return money(value)


def _restore_entry(row):
    if (
        not isinstance(row, dict)
        or not set(ENTRY_COLUMNS) <= set(row)
        or set(row) - set(ENTRY_COLUMNS + ["received_cents", "paid_cents"])
    ):
        raise ValidationError("备份单据字段不完整或包含未知字段")
    _audit_fields(row)
    payload = {
        k: row[k] for k in ("kind", "date", "description", "category", "note", "external_id")
    }
    if row["kind"] == "sale":
        payload.update(
            quantity=row["quantity"],
            unit_price=_cents(row["unit_price_cents"]),
            unit_cost=_cents(row["unit_cost_cents"]),
        )
    else:
        payload["amount"] = _cents(row["amount_cents"])
    normalized = validate_entry(payload)
    for key, value in normalized.items():
        if type(row[key]) is not type(value) or row[key] != value:
            raise ValidationError(f"单据字段 {key} 与重新计算的值不一致")
    return {key: row[key] for key in ENTRY_COLUMNS}


def _restore_payment(row):
    if not isinstance(row, dict) or set(row) != set(PAYMENT_COLUMNS):
        raise ValidationError("备份流水字段不完整或包含未知字段")
    _audit_fields(row)
    normalized = validate_payment(
        {
            "kind": row["kind"],
            "entry_id": row["entry_id"],
            "date": row["date"],
            "amount": _cents(row["amount_cents"]),
            "note": row["note"],
        }
    )
    for key, value in normalized.items():
        if type(row[key]) is not type(value) or row[key] != value:
            raise ValidationError(f"流水字段 {key} 无效")
    return row.copy()


def _validate_backup(backup):
    if not isinstance(backup, dict) or set(backup) != {
        "version",
        "currency",
        "demo",
        "exported_at",
        "entries",
        "payments",
    }:
        raise ValidationError("备份结构不完整或包含未知字段")
    if (
        type(backup["version"]) is not int
        or backup["version"] != 1
        or backup["currency"] != "CNY"
        or type(backup["demo"]) is not bool
    ):
        raise ValidationError("不支持的备份版本、币种或示例标记")
    _timestamp(backup["exported_at"])
    if not isinstance(backup["entries"], list) or not isinstance(backup["payments"], list):
        raise ValidationError("备份单据与流水须为列表")
    if len(backup["entries"]) + len(backup["payments"]) > MAX_RECORDS:
        raise ValidationError("备份记录不能超过 10,000 条")
    entries = [_restore_entry(row) for row in backup["entries"]]
    payments = [_restore_payment(row) for row in backup["payments"]]
    ids = [r["id"] for r in entries + payments]
    if len(ids) != len(set(ids)):
        raise ValidationError("备份记录编号重复")
    externals = [e["external_id"] for e in entries if e["external_id"] is not None]
    if len(externals) != len(set(externals)):
        raise ValidationError("备份外部编号重复")
    by_id = {e["id"]: e for e in entries}
    paid = {}
    for p in payments:
        if p["entry_id"] is None:
            continue
        e = by_id.get(p["entry_id"])
        if e is None or e["kind"] != ("expense" if p["kind"] == "expense_payment" else "sale"):
            raise ValidationError("流水关联单据缺失或类型不符")
        if p["date"] < e["date"]:
            raise ValidationError("流水日期早于关联业务日期")
        limit = e[
            {
                "receipt": "revenue_cents",
                "cost_payment": "cost_cents",
                "expense_payment": "amount_cents",
            }[p["kind"]]
        ]
        if p["amount_cents"] > limit:
            raise ValidationError("流水金额超过对应单据金额")
        if p["voided_at"] is None:
            if e["voided_at"] is not None:
                raise ValidationError("有效流水不能关联已作废单据")
            key = (p["entry_id"], p["kind"])
            paid[key] = paid.get(key, 0) + p["amount_cents"]
            if paid[key] > limit:
                raise ValidationError("累计收付款超过对应单据金额")
    return entries, payments


def restore_backup(store, backup):
    try:
        entries, payments = _validate_backup(backup)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise LedgerError(f"备份校验失败：{exc}") from exc
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute(
            "SELECT (SELECT COUNT(*) FROM entries)+(SELECT COUNT(*) FROM payments)"
        ).fetchone()[0]:
            raise LedgerError("只能恢复到完全空白的账本，不会覆盖现有记录", 409)
        for table, columns, rows in [
            ("entries", ENTRY_COLUMNS, entries),
            ("payments", PAYMENT_COLUMNS, payments),
        ]:
            sql = f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})"
            conn.executemany(sql, [tuple(row[k] for k in columns) for row in rows])
        conn.execute(
            "INSERT INTO metadata(key,value) VALUES ('demo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("true" if backup["demo"] else "false",),
        )
    return {"restored_entries": len(entries), "restored_payments": len(payments)}


def _payload(payload, key):
    if not isinstance(payload, dict) or set(payload) != {key}:
        raise LedgerError(f"请求只应包含 {key} 字段")
    return payload[key]


def _download(content, filename):
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/entries.csv")
def entries_download(request: Request):
    return _download(export_entries(request.app.state.store), "ledger-entries.csv")


@router.get("/export/payments.csv")
def payments_download(request: Request):
    return _download(export_payments(request.app.state.store), "ledger-payments.csv")


@router.get("/import/template.csv")
def template_download():
    return _download(
        _csv_output(
            FIELDS,
            [
                dict(
                    zip(
                        FIELDS,
                        [
                            "example-sale-001",
                            "sale",
                            "2026-10-01",
                            "帆布袋",
                            "商品",
                            "10",
                            "20.00",
                            "8.00",
                            "",
                            "虚构例子，请替换",
                        ],
                    )
                ),
                dict(
                    zip(
                        FIELDS,
                        [
                            "example-expense-001",
                            "expense",
                            "2026-10-02",
                            "摊位费",
                            "租金",
                            "",
                            "",
                            "",
                            "100.00",
                            "虚构例子，请替换",
                        ],
                    )
                ),
            ],
        ),
        "ledger-template.csv",
    )


@router.post("/import/preview")
def preview_endpoint(request: Request, payload: dict):
    return preview_csv(request.app.state.store, _payload(payload, "csv_text"))


@router.post("/import/commit")
def commit_endpoint(request: Request, payload: dict):
    return commit_csv(request.app.state.store, _payload(payload, "csv_text"))


@router.get("/backup")
def backup_endpoint(request: Request):
    return JSONResponse(
        make_backup(request.app.state.store),
        headers={"Content-Disposition": 'attachment; filename="ledger-backup.json"'},
    )


@router.post("/restore")
def restore_endpoint(request: Request, payload: dict):
    return restore_backup(request.app.state.store, _payload(payload, "backup"))
