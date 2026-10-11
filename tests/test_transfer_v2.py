"""Lossless CSV and JSON v2 transfers with real legacy v1 data."""

import copy
import csv
import io
import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from small_business_ledger import transfer
from small_business_ledger.app import create_app
from small_business_ledger.models import ValidationError
from small_business_ledger.store import LedgerError, Store

ENTRY_ID = "11111111-1111-4111-8111-111111111111"
PAYMENT_ID = "22222222-2222-4222-8222-222222222222"
KEY = "33333333-3333-4333-8333-333333333333"
ENTRY_DIGEST = "f78a944e650231aa0ead4c139d6990c1d9444d920b541a9a7204fbd54700d2f0"
LEGACY_FIELDS = (
    "external_id,kind,date,description,category,quantity,unit_price,unit_cost,amount,note"
)
NEW_FIELDS = ",customer,supplier,receivable_due_date,payable_due_date"
LEGACY_CSV = LEGACY_FIELDS + "\ns-1,sale,2026-10-01,订单,商品,2,50,20,,\n"
NEW_CSV = (
    LEGACY_FIELDS
    + NEW_FIELDS
    + "\ns-1,sale,2026-10-01,订单,商品,2,50,20,,,客户甲,工厂乙,2026-10-05,2026-10-10\n"
)


def legacy_backup():
    return {
        "version": 1,
        "currency": "CNY",
        "demo": True,
        "exported_at": "2026-10-12T00:00:00+00:00",
        "entries": [
            {
                "id": ENTRY_ID,
                "kind": "sale",
                "date": "2026-10-01",
                "description": "订单",
                "category": "商品",
                "quantity": 2,
                "unit_price_cents": 5000,
                "unit_cost_cents": 2000,
                "revenue_cents": 10000,
                "cost_cents": 4000,
                "amount_cents": 10000,
                "note": "",
                "external_id": "s-1",
                "created_at": "2026-10-01T00:00:00+00:00",
                "voided_at": None,
                "void_reason": None,
            }
        ],
        "payments": [
            {
                "id": PAYMENT_ID,
                "kind": "receipt",
                "entry_id": ENTRY_ID,
                "date": "2026-10-03",
                "amount_cents": 2500,
                "note": "",
                "created_at": "2026-10-03T00:00:00+00:00",
                "voided_at": None,
                "void_reason": None,
            }
        ],
    }


def v2_backup():
    backup = legacy_backup()
    backup["version"] = 2
    backup["entries"][0].update(
        customer="客户甲",
        supplier="工厂乙",
        receivable_due_date="2026-10-05",
        payable_due_date="2026-10-10",
    )
    backup["write_requests"] = [
        {
            "key": KEY,
            "operation": "entry.create",
            "payload_hash": ENTRY_DIGEST,
            "record_id": ENTRY_ID,
        }
    ]
    return backup


def test_v1_backup_normalizes_new_fields_and_does_not_mutate_source():
    backup = legacy_backup()
    original = copy.deepcopy(backup)
    entries, payments = transfer._validate_backup(backup)
    assert entries[0]["customer"] == entries[0]["supplier"] == ""
    assert entries[0]["receivable_due_date"] is entries[0]["payable_due_date"] is None
    assert payments[0]["id"] == PAYMENT_ID
    assert backup == original


def test_v2_backup_validates_labels_and_exposes_request_mappings():
    backup = v2_backup()
    entries, payments = transfer._validate_backup(backup)
    assert entries[0]["customer"] == "客户甲"
    assert transfer.validated_requests(backup, entries, payments) == [
        {
            "key": KEY,
            "operation": "entry.create",
            "payload_hash": ENTRY_DIGEST,
            "record_id": ENTRY_ID,
        }
    ]


@pytest.mark.parametrize(
    "mutation",
    [
        lambda b: b["write_requests"][0].update(key="bad"),
        lambda b: b["write_requests"][0].update(record_id="bad"),
        lambda b: b["write_requests"][0].update(record_id=str(uuid4())),
        lambda b: b["write_requests"][0].update(record_id=PAYMENT_ID),
        lambda b: b["write_requests"][0].update(operation="payment.create"),
        lambda b: b["write_requests"][0].update(operation="entry.void"),
        lambda b: b["write_requests"][0].update(operation=[]),
        lambda b: b["write_requests"][0].update(payload_hash="a" * 63),
        lambda b: b["write_requests"][0].update(payload_hash="g" * 64),
        lambda b: b["write_requests"][0].update(payload_hash=None),
        lambda b: b["write_requests"][0].update(surprise=True),
        lambda b: b["write_requests"].append(dict(b["write_requests"][0])),
        lambda b: b["write_requests"].append(dict(b["write_requests"][0], key=str(uuid4()))),
        lambda b: b.update(write_requests={}),
        lambda b: b.update(write_requests=[None]),
        lambda b: b["entries"][0].update(receivable_due_date="2026-09-30"),
        lambda b: b["entries"][0].pop("customer"),
    ],
)
def test_v2_rejects_invalid_mappings_and_metadata(mutation):
    backup = v2_backup()
    mutation(backup)
    with pytest.raises(ValidationError):
        transfer._validate_backup(backup)


def test_legacy_connection_exports_genuine_v1_without_request_table():
    backup = legacy_backup()
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        for table in ("entries", "payments"):
            row = backup[table][0]
            columns = list(row)
            conn.execute(f"CREATE TABLE {table} ({','.join(columns)})")
            conn.execute(
                f"INSERT INTO {table} VALUES ({','.join('?' for _ in columns)})",
                tuple(row.values()),
            )
        conn.execute("CREATE TABLE metadata (key TEXT, value TEXT)")
        conn.execute("INSERT INTO metadata VALUES ('demo','true')")
        result = getattr(transfer, "make_backup_from_connection", lambda *_: None)(conn)
    assert result is not None, "connection-based snapshot export is missing"
    assert result["version"] == 1
    assert "write_requests" not in result
    assert result["entries"] == backup["entries"]
    assert result["payments"] == backup["payments"]
    transfer._validate_backup(result)


def test_old_and_new_csv_headers_parse_with_optional_metadata():
    legacy = transfer._parse_csv(LEGACY_CSV, [])
    assert legacy["errors"] == []
    modern = transfer._parse_csv(NEW_CSV, [])
    assert modern["errors"] == []
    assert modern["rows"][0]["customer"] == "客户甲"
    assert modern["rows"][0]["payable_due_date"] == "2026-10-10"
    partial = transfer._parse_csv(
        LEGACY_FIELDS + ",supplier\ns-1,sale,2026-10-01,订单,商品,2,50,20,,,工厂乙\n", []
    )
    assert partial["errors"] == []
    assert partial["rows"][0]["supplier"] == "工厂乙"


def test_new_csv_rejects_bad_due_without_writing(tmp_path):
    store = Store(tmp_path / "ledger.db")
    with pytest.raises(LedgerError):
        transfer.commit_csv(store, NEW_CSV.replace("2026-10-05", "2026-09-30"))
    assert store.meta()["entry_count"] == 0


def test_v2_roundtrip_preserves_counterparties_and_formula_escaping(tmp_path):
    source, target = Store(tmp_path / "source.db"), Store(tmp_path / "target.db")
    transfer.commit_csv(source, NEW_CSV.replace("客户甲", "=1+1").replace("工厂乙", "'+供货商"))
    exported = transfer.export_entries(source)
    row = next(csv.DictReader(io.StringIO(exported.lstrip("\ufeff"))))
    assert row["customer"] == "'=1+1"
    assert row["supplier"] == "''+供货商"
    transfer.commit_csv(target, exported)
    actual = target.entries()[0]
    assert (actual["customer"], actual["supplier"]) == ("=1+1", "'+供货商")
    assert (actual["receivable_due_date"], actual["payable_due_date"]) == (
        "2026-10-05",
        "2026-10-10",
    )


@pytest.mark.parametrize("version", [1, 2])
def test_restore_keeps_legacy_ids_and_v2_request_mapping(tmp_path, version):
    backup = legacy_backup() if version == 1 else v2_backup()
    target = Store(tmp_path / "target.db")
    assert transfer.restore_backup(target, backup) == {
        "restored_entries": 1,
        "restored_payments": 1,
    }
    exported = transfer.make_backup(target)
    assert exported["version"] == 2
    assert exported["entries"][0]["id"] == ENTRY_ID
    assert exported["payments"][0]["entry_id"] == ENTRY_ID
    assert exported["demo"] is True
    assert exported["write_requests"] == backup.get("write_requests", [])
    assert target.summary("2026-10-01", "2026-10-10")["receivable_cents"] == 7500


def test_csv_import_snapshot_failure_is_atomic(tmp_path, monkeypatch):
    store = Store(tmp_path / "ledger.db")
    transfer.commit_csv(store, LEGACY_CSV)

    def unavailable(conn):
        assert conn.in_transaction
        raise LedgerError("备份不可用", 503)

    monkeypatch.setattr(store, "before_write", unavailable)
    with pytest.raises(LedgerError, match="备份不可用"):
        transfer.commit_csv(store, LEGACY_CSV.replace("s-1", "s-2"))
    assert len(store.entries()) == 1


def test_restore_prewrite_failure_keeps_empty_ledger(tmp_path, monkeypatch):
    store = Store(tmp_path / "ledger.db")

    def unavailable(conn):
        assert conn.in_transaction
        raise LedgerError("备份不可用", 503)

    monkeypatch.setattr(store, "before_write", unavailable)
    with pytest.raises(LedgerError, match="备份不可用"):
        transfer.restore_backup(store, v2_backup())
    assert store.entries() == []


def test_outstanding_csv_route_respects_cutoff_and_protects_text(tmp_path):
    app = create_app(tmp_path / "ledger.db")
    transfer.commit_csv(app.state.store, NEW_CSV.replace("客户甲", "=1+1"))
    with TestClient(app, base_url="http://127.0.0.1") as client:
        response = client.get("/api/export/outstanding.csv?as_of=2026-10-10")
        assert response.status_code == 200
        assert response.content.startswith(b"\xef\xbb\xbf")
        assert "attachment" in response.headers["content-disposition"]
        rows = list(csv.DictReader(io.StringIO(response.text.lstrip("\ufeff"))))
        assert len(rows) == 2
        assert rows[0]["counterparty"] == "'=1+1"
        assert rows[0]["outstanding"] == "100.00"
        assert rows[0]["as_of"] == "2026-10-10"
        assert rows[1]["status"] == "due_today"
        assert client.get("/api/export/outstanding.csv?as_of=2026-02-30").status_code == 422


@pytest.mark.parametrize("operation", ["entry.create", "payment.create"])
@pytest.mark.parametrize("corruption", ["swapped_records", "changed_digest"])
def test_restore_rejects_request_digest_unrelated_to_its_record(tmp_path, operation, corruption):
    source = Store(tmp_path / "source.db")
    if operation == "entry.create":
        for amount in ("10", "20"):
            source.create_entry(
                {
                    "kind": "expense",
                    "date": "2026-10-01",
                    "description": "租金",
                    "category": "费用",
                    "amount": amount,
                },
                request_id=str(uuid4()),
            )
    else:
        for amount in ("10", "20"):
            source.create_payment(
                {"kind": "capital_in", "date": "2026-10-01", "amount": amount},
                request_id=str(uuid4()),
            )
    backup = transfer.make_backup(source)
    first, second = backup["write_requests"]
    if corruption == "swapped_records":
        first["record_id"], second["record_id"] = second["record_id"], first["record_id"]
    else:
        first["payload_hash"] = "0" * 64
    target = Store(tmp_path / "target.db")
    with pytest.raises(LedgerError, match="摘要"):
        transfer.restore_backup(target, backup)
    assert target.entries() == []
    assert target.payments() == []
    with target.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM write_requests").fetchone()[0] == 0


@pytest.mark.parametrize("voided", [False, True])
def test_restored_genuine_mappings_replay_original_entry_and_payment(tmp_path, voided):
    source = Store(tmp_path / "source.db")
    entry_key, payment_key = str(uuid4()), str(uuid4())
    entry_payload = {
        "kind": "sale",
        "date": "2026-10-01",
        "description": "定制订单",
        "category": "商品",
        "quantity": 3,
        "unit_price": "12.5",
        "unit_cost": "2",
        "customer": "客户甲",
        "supplier": "工厂乙",
        "receivable_due_date": "2026-10-05",
        "payable_due_date": "2026-10-10",
        "note": "分两次收款",
    }
    entry = source.create_entry(entry_payload, request_id=entry_key)
    payment_payload = {
        "kind": "receipt",
        "entry_id": entry["id"],
        "date": "2026-10-03",
        "amount": "10",
        "note": "首款",
    }
    payment = source.create_payment(payment_payload, request_id=payment_key)
    if voided:
        source.void_payment(payment["id"], "重新核对")
        source.void_entry(entry["id"], "取消订单")
    target = Store(tmp_path / "target.db")
    transfer.restore_backup(target, transfer.make_backup(source))
    replay_entry = target.create_entry(
        entry_payload | {"unit_price": "12.50"}, request_id=entry_key
    )
    replay_payment = target.create_payment(
        payment_payload | {"amount": "10.00"}, request_id=payment_key
    )
    assert replay_entry["id"] == entry["id"]
    assert replay_payment["id"] == payment["id"]
    assert bool(replay_entry["voided_at"]) is voided
    assert bool(replay_payment["voided_at"]) is voided
    assert len(target.entries()) == len(target.payments()) == 1


@pytest.mark.parametrize("import_count", [1, 2])
def test_csv_checks_entire_batch_capacity_before_creating_snapshot(tmp_path, import_count):
    store = Store(tmp_path / "ledger.db")
    seed = store.create_entry(
        {
            "kind": "expense",
            "date": "2026-10-01",
            "description": "日常费用",
            "category": "费用",
            "amount": "1",
        }
    )
    store.create_payment({"kind": "capital_in", "date": "2026-10-01", "amount": "1"})
    raw = {key: value for key, value in seed.items() if key not in {"received_cents", "paid_cents"}}
    columns = list(raw)
    # 9,998 entries + one payment leave exactly one available record slot.
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            f"INSERT INTO entries ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
            [
                tuple(str(uuid4()) if key == "id" else raw[key] for key in columns)
                for _ in range(9997)
            ],
        )
    original = transfer.make_backup(store)
    backups = store.local_backups()
    content = LEGACY_CSV
    if import_count == 2:
        content += "s-2,sale,2026-10-01,另一订单,商品,2,50,20,,\n"
        with pytest.raises(LedgerError) as rejected:
            transfer.commit_csv(store, content)
        assert rejected.value.status_code == 409
        restored = transfer.make_backup(store)
        assert restored["entries"] == original["entries"]
        assert restored["payments"] == original["payments"]
        assert store.local_backups() == backups
    else:
        assert transfer.commit_csv(store, content) == {"imported": 1}
        assert store.meta()["entry_count"] == 9999
        assert store.meta()["payment_count"] == 1
