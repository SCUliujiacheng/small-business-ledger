"""Android transport adapter. Every accounting operation uses the desktop core."""

import json
import re
from pathlib import Path

from small_business_ledger import transfer
from small_business_ledger.store import LedgerError, Store


def response(value, status=200, filename=None):
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if filename:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return status, headers, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")


def csv_response(value, filename):
    return (
        200,
        {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
        value.encode("utf-8"),
    )


class LedgerApp:
    def __init__(self, data_dir):
        self.store = Store(Path(data_dir) / "ledger.db")

    def handle(self, method, path, query, body, headers):
        try:
            if method not in {"GET", "HEAD"}:
                if headers.get("x-ledger-request") != "1":
                    return response({"detail": "写操作需要 X-Ledger-Request 请求头"}, 403)
                if not isinstance(body, dict):
                    return response({"detail": "请求格式不正确，请检查字段类型和必填项"}, 422)
            return self.dispatch(method, path, query, body, headers)
        except LedgerError as exc:
            return response({"detail": exc.detail}, exc.status_code)

    def dispatch(self, method, path, query, body, headers):
        store = self.store

        def parameter(name):
            values = query.get(name, [])
            if len(values) != 1 or not isinstance(values[0], str):
                raise LedgerError("请求格式不正确，请检查字段类型和必填项")
            return values[0]

        if method in {"GET", "HEAD"}:
            getters = {
                "/api/meta": store.meta,
                "/api/entries": lambda: {"items": store.entries()},
                "/api/payments": lambda: {"items": store.payments()},
                "/api/summary": lambda: store.summary(parameter("start"), parameter("end")),
                "/api/outstanding": lambda: store.outstanding(parameter("as_of")),
                "/api/local-backups": store.local_backups,
            }
            if path in getters:
                return response(getters[path]())
            downloads = {
                "/api/export/entries.csv": (
                    lambda: transfer.export_entries(store),
                    "ledger-entries.csv",
                ),
                "/api/export/payments.csv": (
                    lambda: transfer.export_payments(store),
                    "ledger-payments.csv",
                ),
                "/api/export/outstanding.csv": (
                    lambda: transfer.export_outstanding(store, parameter("as_of")),
                    "ledger-outstanding.csv",
                ),
                "/api/import/template.csv": (transfer.export_template, "ledger-template.csv"),
            }
            if path in downloads:
                operation, filename = downloads[path]
                return csv_response(operation(), filename)
            if path == "/api/backup":
                return response(transfer.make_backup(store), filename="ledger-backup.json")
            match = re.fullmatch(r"/api/local-backups/([^/]+)", path)
            if match:
                return response(store.read_snapshot(match[1]), filename=match[1])
        if method == "POST":
            if path == "/api/entries":
                return response(store.create_entry(body, headers.get("idempotency-key")), 201)
            if path == "/api/payments":
                return response(store.create_payment(body, headers.get("idempotency-key")), 201)
            match = re.fullmatch(r"/api/(entries|payments)/([^/]+)/void", path)
            if match:
                if set(body) != {"reason"}:
                    raise LedgerError("作废请求只接受 reason 字段")
                operation = store.void_entry if match[1] == "entries" else store.void_payment
                return response(operation(match[2], body["reason"]))
            if path == "/api/demo":
                if body:
                    raise LedgerError("示例请求须为空对象")
                return response(store.seed_demo())
            if path == "/api/local-backups":
                if body:
                    raise LedgerError("备份请求须为空对象")
                return response(store.snapshot_now(), 201)
            if path == "/api/import/preview":
                return response(transfer.preview_csv(store, transfer._payload(body, "csv_text")))
            if path == "/api/import/commit":
                return response(transfer.commit_csv(store, transfer._payload(body, "csv_text")))
            if path == "/api/restore":
                return response(transfer.restore_backup(store, transfer._payload(body, "backup")))
        return response({"detail": "接口不存在"}, 404)


def create_app(data_dir: str, resource_dir: str):
    return LedgerApp(data_dir)
