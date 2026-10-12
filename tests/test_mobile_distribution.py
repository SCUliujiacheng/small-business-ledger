"""The APK must use the ledger's real core without native FastAPI dependencies."""

import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from small_business_ledger.app import create_app

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "distribution"))
WRITE = {"x-ledger-request": "1", "content-type": "application/json"}


def mobile(tmp_path):
    from mobile_app import create_app as create_mobile

    return create_mobile(str(tmp_path), str(ROOT))


def call(app, method, path, body=None, query=None, headers=None):
    status, response_headers, raw = app.handle(method, path, query or {}, body, headers or WRITE)
    value = (
        json.loads(raw)
        if response_headers.get("Content-Type", "").startswith("application/json")
        else raw.decode("utf-8")
    )
    return status, value


def test_mobile_core_imports_without_site_packages(tmp_path):
    script = (
        "import sys; sys.path[:0] = "
        + repr([str(ROOT / "distribution"), str(ROOT / "src")])
        + "; import mobile_app; app = mobile_app.create_app("
        + repr(str(tmp_path))
        + ", '.'); assert app.handle('GET', '/api/meta', {}, None, {})[0] == 200"
    )
    result = subprocess.run(
        [sys.executable, "-S", "-c", script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_mobile_cashflow_idempotency_restore_and_restart(tmp_path):
    app = mobile(tmp_path / "phone")
    key = str(uuid4())
    payload = {
        "kind": "sale",
        "date": "2026-10-01",
        "description": "手工帆布袋",
        "category": "商品",
        "quantity": 2,
        "unit_price": "20.00",
        "unit_cost": "8.00",
        "customer": "客户甲",
    }
    status, entry = call(
        app, "POST", "/api/entries", payload, headers=WRITE | {"idempotency-key": key}
    )
    assert status == 201
    assert entry["revenue_cents"] == 4000 and entry["cost_cents"] == 1600
    assert call(app, "POST", "/api/entries", payload, headers=WRITE | {"idempotency-key": key}) == (
        201,
        entry,
    )
    assert (
        call(
            app,
            "POST",
            "/api/payments",
            {"kind": "receipt", "entry_id": entry["id"], "date": "2026-10-02", "amount": "10.00"},
        )[0]
        == 201
    )
    app = mobile(tmp_path / "phone")
    _, backup = call(app, "GET", "/api/backup")
    with TestClient(create_app(tmp_path / "desktop.db"), base_url="http://localhost") as desktop:
        assert (
            desktop.post("/api/restore", json={"backup": backup}, headers=WRITE).status_code == 200
        )
        for path, query in [
            ("/api/entries", {}),
            ("/api/payments", {}),
            ("/api/summary", {"start": ["2026-10-01"], "end": ["2026-10-31"]}),
            ("/api/outstanding", {"as_of": ["2026-10-02"]}),
        ]:
            status, result = call(app, "GET", path, query=query)
            expected = desktop.get(path, params={k: v[0] for k, v in query.items()})
            assert (status, result) == (expected.status_code, expected.json())
        assert (
            call(app, "GET", "/api/export/entries.csv")[1]
            == desktop.get("/api/export/entries.csv").text
        )
    empty = mobile(tmp_path / "restored")
    assert call(empty, "POST", "/api/restore", {"backup": backup}) == (
        200,
        {"restored_entries": 1, "restored_payments": 1},
    )
    assert call(empty, "POST", "/api/restore", {"backup": backup})[0] == 409


@pytest.mark.parametrize(
    "method,path,body,query",
    [
        ("GET", "/api/summary", None, {}),
        ("GET", "/api/outstanding", None, {}),
        ("POST", "/api/entries", {}, {}),
        ("POST", "/api/payments", {}, {}),
        ("POST", "/api/restore", {"backup": []}, {}),
        ("POST", "/api/import/commit", {"csv_text": "invalid"}, {}),
        ("POST", "/api/demo", {"unexpected": True}, {}),
        ("POST", "/api/local-backups", {"unexpected": True}, {}),
        ("GET", "/api/not-real", None, {}),
    ],
)
def test_mobile_errors_match_desktop_status(tmp_path, method, path, body, query):
    with TestClient(create_app(tmp_path / "desktop.db"), base_url="http://localhost") as desktop:
        response = desktop.request(method, path, json=body, headers=WRITE)
    assert call(mobile(tmp_path / "phone"), method, path, body, query)[0] == response.status_code


def test_template_csv_snapshot_and_void_work_on_mobile(tmp_path):
    app = mobile(tmp_path)
    _, csv_text = call(app, "GET", "/api/import/template.csv")
    assert call(app, "POST", "/api/import/preview", {"csv_text": csv_text})[1]["count"] == 2
    assert call(app, "POST", "/api/import/commit", {"csv_text": csv_text}) == (200, {"imported": 2})
    _, entries = call(app, "GET", "/api/entries")
    assert (
        call(
            app, "POST", "/api/entries/" + entries["items"][0]["id"] + "/void", {"reason": "录重了"}
        )[0]
        == 200
    )
    status, snapshot = call(app, "POST", "/api/local-backups", {})
    assert status == 201
    assert call(app, "GET", "/api/local-backups/" + snapshot["filename"])[1]["entries"]
    assert call(app, "GET", "/api/local-backups/../../secret")[0] == 404


def test_mobile_write_header_and_object_boundary(tmp_path):
    app = mobile(tmp_path)
    assert app.handle("POST", "/api/demo", {}, {}, {})[0] == 403
    assert app.handle("POST", "/api/demo", {}, [], WRITE)[0] == 422
