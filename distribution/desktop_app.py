"""Use writable per-user storage, never the installation directory."""

import json
import urllib.request
from pathlib import Path
from uuid import uuid4

from small_business_ledger.app import create_app as ledger_app


def create_app(data_dir: str, resource_dir: str):
    return ledger_app(Path(data_dir) / "ledger.db", frontend_dir=Path(resource_dir) / "web")


def smoke_test(origin, cookie):
    """Exercise the frozen executable against its temporary smoke ledger."""
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(path, body=None, key=None):
        headers = {"Cookie": cookie, "Content-Type": "application/json", "X-Ledger-Request": "1"}
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(
            origin + path, data=None if body is None else json.dumps(body).encode(), headers=headers
        )
        with client.open(request, timeout=30) as response:
            return json.load(response)

    key = str(uuid4())
    payload = {
        "kind": "sale",
        "date": "2026-10-01",
        "description": "Packaging smoke / 虚构数据",
        "category": "Test",
        "quantity": 2,
        "unit_price": "20.00",
        "unit_cost": "8.00",
    }
    entry = call("/api/entries", payload, key)
    assert call("/api/entries", payload, key)["id"] == entry["id"]
    call(
        "/api/payments",
        {"kind": "receipt", "entry_id": entry["id"], "date": "2026-10-02", "amount": "10.00"},
    )
    summary = call("/api/summary?start=2026-10-01&end=2026-10-31")
    assert (
        summary["revenue_cents"],
        summary["profit_cents"],
        summary["receivable_cents"],
        summary["cash_in_cents"],
    ) == (4000, 2400, 3000, 1000)
    backup = call("/api/backup")
    assert len(backup["entries"]) == len(backup["payments"]) == len(backup["write_requests"]) == 1
    assert call("/api/local-backups")["items"]
