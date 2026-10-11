"""Exercise the migration routes over HTTP, not just their helper functions."""

from fastapi.testclient import TestClient

from small_business_ledger.app import create_app

WRITE = {"X-Ledger-Request": "1"}


def client_at(path):
    return TestClient(create_app(path), base_url="http://127.0.0.1")


def test_template_preview_import_download_and_restore(tmp_path):
    with client_at(tmp_path / "source.db") as client:
        template = client.get("/api/import/template.csv")
        assert template.status_code == 200
        assert template.content.startswith(b"\xef\xbb\xbf")
        assert "attachment" in template.headers["content-disposition"]
        preview = client.post(
            "/api/import/preview", json={"csv_text": template.text}, headers=WRITE
        )
        assert preview.json()["count"] == 2
        assert client.get("/api/meta").json()["entry_count"] == 0
        saved = client.post("/api/import/commit", json={"csv_text": template.text}, headers=WRITE)
        assert saved.json() == {"imported": 2}
        summary = client.get("/api/summary?start=2026-10-01&end=2026-10-31").json()
        assert summary["revenue_cents"] == 20000
        assert summary["profit_cents"] == 2000
        assert summary["cash_in_cents"] == 0
        assert "text_encoding" in client.get("/api/export/entries.csv").text
        assert "amount" in client.get("/api/export/payments.csv").text
        backup = client.get("/api/backup")
        assert backup.headers["cache-control"] == "no-store"
        assert "attachment" in backup.headers["content-disposition"]
        assert (
            client.post("/api/restore", json={"backup": backup.json()}, headers=WRITE).status_code
            == 409
        )
    with client_at(tmp_path / "target.db") as target:
        restored = target.post("/api/restore", json={"backup": backup.json()}, headers=WRITE)
        assert restored.json() == {"restored_entries": 2, "restored_payments": 0}
        assert target.get("/api/summary?start=2026-10-01&end=2026-10-31").json() == summary


def test_migration_writes_require_same_origin_and_header(tmp_path):
    with client_at(tmp_path / "ledger.db") as client:
        for route, body in [
            ("/api/import/commit", {"csv_text": ""}),
            ("/api/restore", {"backup": {}}),
            ("/api/demo", {}),
        ]:
            assert client.post(route, json=body).status_code == 403
            assert (
                client.post(
                    route, json=body, headers=WRITE | {"Origin": "https://attacker.example"}
                ).status_code
                == 403
            )
        assert client.get("/api/backup", headers={"Host": "attacker.example"}).status_code == 403
        assert client.get("/api/meta").json()["entry_count"] == 0


def test_transfer_invalid_json_shape_is_422_without_db_changes(tmp_path):
    with client_at(tmp_path / "ledger.db") as client:
        assert (
            client.post(
                "/api/import/preview", json={"csv_text": "", "surprise": 1}, headers=WRITE
            ).status_code
            == 422
        )
        assert client.post("/api/restore", json={"backup": []}, headers=WRITE).status_code == 422
        assert client.post("/api/restore", json={"backup": None}, headers=WRITE).status_code == 422
        assert client.get("/api/meta").json()["entry_count"] == 0


def test_wrong_json_shape_with_surrogate_cannot_crash_error_response(tmp_path):
    with client_at(tmp_path / "ledger.db") as client:
        for body in [b'["\\ud800"]', b'"\\ud800"']:
            response = client.post(
                "/api/entries", content=body, headers=WRITE | {"Content-Type": "application/json"}
            )
            assert response.status_code == 422
        assert client.get("/api/meta").json()["entry_count"] == 0


def test_demo_backup_keeps_demo_label_after_restore(tmp_path):
    with client_at(tmp_path / "source.db") as source:
        assert source.post("/api/demo", json={}, headers=WRITE).status_code == 200
        backup = source.get("/api/backup").json()
        assert backup["demo"] is True
    with client_at(tmp_path / "target.db") as target:
        assert (
            target.post("/api/restore", json={"backup": backup}, headers=WRITE).status_code == 200
        )
        assert target.get("/api/meta").json()["demo"] is True


def test_backup_larger_than_normal_request_limit_restores(tmp_path):
    """A valid ledger must never export a backup that this app cannot restore."""
    import json
    from uuid import uuid4

    from small_business_ledger.store import Store

    source_store = Store(tmp_path / "source.db")
    original = source_store.create_entry(
        {
            "kind": "expense",
            "date": "2026-10-01",
            "description": "租金",
            "category": "费用",
            "amount": "1.00",
            "note": "备" * 500,
        }
    )
    # Replicate a validated raw row, with fresh IDs, in one transaction for test speed.
    raw = {
        key: value for key, value in original.items() if key not in {"received_cents", "paid_cents"}
    }
    columns = list(raw)
    with source_store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        sql = f"INSERT INTO entries ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})"
        conn.executemany(
            sql,
            [
                tuple((str(uuid4()) if key == "id" else raw[key]) for key in columns)
                for _ in range(5999)
            ],
        )
    with client_at(tmp_path / "source.db") as source:
        backup = source.get("/api/backup")
        assert len(backup.content) > 10 * 1024 * 1024
    with client_at(tmp_path / "target.db") as target:
        envelope = json.dumps({"backup": backup.json()}, ensure_ascii=False).encode("utf-8")
        restored = target.post(
            "/api/restore", content=envelope, headers=WRITE | {"Content-Type": "application/json"}
        )
        assert restored.status_code == 200
        assert target.get("/api/meta").json()["entry_count"] == 6000
