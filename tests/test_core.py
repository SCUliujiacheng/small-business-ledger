"""Behavioral checks against a real temporary SQLite database and ASGI app."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Barrier

import pytest

SALE = {
    "kind": "sale",
    "date": "2026-10-01",
    "description": "帆布袋",
    "category": "商品",
    "quantity": 3,
    "unit_price": "10.10",
    "unit_cost": "2.05",
}
EXPENSE = {
    "kind": "expense",
    "date": "2026-10-02",
    "description": "房租",
    "category": "房租",
    "amount": "20.00",
}


def new_store(tmp_path):
    from small_business_ledger.store import Store

    return Store(tmp_path / "ledger.db")


def payment(store, entry, kind, amount, day="2026-10-02"):
    return store.create_payment(
        {"kind": kind, "entry_id": entry["id"] if entry else None, "date": day, "amount": amount}
    )


def test_sale_arithmetic_uses_exact_cents_and_persists(tmp_path):
    store = new_store(tmp_path)
    sale = store.create_entry(SALE)
    assert (sale["revenue_cents"], sale["cost_cents"], sale["amount_cents"]) == (3030, 615, 3030)
    assert sale["received_cents"] == sale["paid_cents"] == 0
    assert new_store(tmp_path).entries() == [sale]


@pytest.mark.parametrize(
    "changes",
    [
        {"quantity": True},
        {"quantity": "3"},
        {"quantity": 1.5},
        {"quantity": 0},
        {"quantity": 1_000_001},
        {"unit_price": 10.1},
        {"unit_price": True},
        {"unit_price": "1.001"},
        {"unit_price": "1e2"},
        {"unit_price": "-1"},
        {"unit_price": "NaN"},
        {"unit_cost": "100000000.01"},
        {"unit_price": "50000000"},
        {"date": "2026-02-29"},
        {"date": "1999-12-31"},
        {"date": "2101-01-01"},
        {"date": "2026-1-01"},
        {"description": " "},
        {"description": 3},
        {"category": "x" * 41},
        {"note": "x" * 501},
        {"external_id": ""},
        {"amount": "1"},
        {"unexpected": "field"},
    ],
)
def test_invalid_entry_never_writes_a_record(tmp_path, changes):
    store = new_store(tmp_path)
    with pytest.raises(ValueError):
        store.create_entry(SALE | changes)
    assert store.entries() == []


def test_expense_fields_cannot_include_sale_fields(tmp_path):
    store = new_store(tmp_path)
    with pytest.raises(ValueError):
        store.create_entry(EXPENSE | {"quantity": 2})
    expense = store.create_entry(EXPENSE)
    assert (
        expense["quantity"],
        expense["unit_price_cents"],
        expense["revenue_cents"],
        expense["amount_cents"],
    ) == (None, None, 0, 2000)


def test_external_id_remains_reserved_after_void(tmp_path):
    store = new_store(tmp_path)
    entry = store.create_entry(SALE | {"external_id": "source-1"})
    store.void_entry(entry["id"], "重复登记")
    with pytest.raises(ValueError) as error:
        store.create_entry(SALE | {"external_id": "source-1"})
    assert error.value.status_code == 409
    assert len(store.entries()) == 1


def test_payments_enforce_relation_date_and_remaining_amount(tmp_path):
    store = new_store(tmp_path)
    sale, expense = store.create_entry(SALE), store.create_entry(EXPENSE)
    for entry, kind, amount, day in [
        (sale, "expense_payment", "1", "2026-10-02"),
        (expense, "receipt", "1", "2026-10-02"),
        (sale, "receipt", "1", "2026-09-30"),
        (sale, "cost_payment", "6.16", "2026-10-02"),
        (sale, "receipt", "30.31", "2026-10-02"),
        (sale, "capital_in", "1", "2026-10-02"),
        (None, "receipt", "1", "2026-10-02"),
        (None, "capital_out", "0", "2026-10-02"),
    ]:
        with pytest.raises(ValueError):
            payment(store, entry, kind, amount, day)
    payment(store, sale, "receipt", "10.00")
    payment(store, sale, "receipt", "20.30")
    payment(store, sale, "cost_payment", "6.15")
    with pytest.raises(ValueError):
        payment(store, sale, "receipt", "0.01")
    current = next(item for item in store.entries() if item["id"] == sale["id"])
    assert (current["received_cents"], current["paid_cents"]) == (3030, 615)


def test_concurrent_receipts_cannot_overpay(tmp_path):
    store = new_store(tmp_path)
    sale = store.create_entry(SALE)
    barrier = Barrier(2)

    def compete():
        barrier.wait()
        try:
            payment(store, sale, "receipt", "20.00")
            return "saved"
        except ValueError:
            return "rejected"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: compete(), range(2)))
    assert sorted(results) == ["rejected", "saved"]
    assert store.entries()[0]["received_cents"] == 2000


def test_void_requires_reason_and_preserves_audit_and_releases_balance(tmp_path):
    store = new_store(tmp_path)
    sale = store.create_entry(SALE)
    receipt = payment(store, sale, "receipt", "30.30")
    with pytest.raises(ValueError):
        store.void_entry(sale["id"], "更正")
    with pytest.raises(ValueError):
        store.void_payment(receipt["id"], " ")
    voided = store.void_payment(receipt["id"], "收错日期")
    assert voided["voided_at"] and voided["void_reason"] == "收错日期"
    replacement = payment(store, sale, "receipt", "30.30")
    store.void_payment(replacement["id"], "重新登记业务")
    voided_sale = store.void_entry(sale["id"], "原单录错")
    assert voided_sale["created_at"] == sale["created_at"]
    assert voided_sale["voided_at"] and voided_sale["void_reason"] == "原单录错"
    with pytest.raises(ValueError):
        store.void_entry(sale["id"], "再次作废")
    with pytest.raises(ValueError):
        payment(store, sale, "receipt", "1")
    assert len(store.payments()) == 2
    assert store.summary("2026-10-01", "2026-10-31")["revenue_cents"] == 0


def test_summary_separates_business_dates_cash_dates_and_end_balances(tmp_path):
    store = new_store(tmp_path)
    old = store.create_entry(
        SALE | {"date": "2026-09-30", "quantity": 1, "unit_price": "100", "unit_cost": "40"}
    )
    sale = store.create_entry(SALE)
    expense = store.create_entry(EXPENSE)
    payment(store, None, "capital_in", "200", "2026-09-01")
    payment(store, old, "receipt", "25", "2026-09-30")
    payment(store, old, "receipt", "25", "2026-10-01")
    payment(store, sale, "receipt", "10", "2026-10-31")
    payment(store, sale, "receipt", "20.30", "2026-11-01")
    payment(store, old, "cost_payment", "10", "2026-10-15")
    payment(store, expense, "expense_payment", "5", "2026-10-31")
    payment(store, None, "capital_out", "3", "2026-10-31")
    summary = store.summary("2026-10-01", "2026-10-31")
    assert {
        key: summary[key]
        for key in ["revenue_cents", "cost_cents", "expense_cents", "profit_cents"]
    } == {"revenue_cents": 3030, "cost_cents": 615, "expense_cents": 2000, "profit_cents": 415}
    assert (
        summary["cash_in_cents"],
        summary["cash_out_cents"],
        summary["net_cash_cents"],
        summary["balance_cents"],
    ) == (3500, 1800, 1700, 24200)
    assert (summary["receivable_cents"], summary["payable_cents"], summary["entry_count"]) == (
        7030,
        5115,
        2,
    )
    assert summary["monthly"] == [
        {
            "month": "2026-10",
            "revenue_cents": 3030,
            "cost_cents": 615,
            "expense_cents": 2000,
            "profit_cents": 415,
            "cash_in_cents": 3500,
            "cash_out_cents": 1800,
        }
    ]


def test_summary_zero_fills_months_and_rejects_invalid_ranges(tmp_path):
    store = new_store(tmp_path)
    assert [item["month"] for item in store.summary("2026-01-31", "2026-03-01")["monthly"]] == [
        "2026-01",
        "2026-02",
        "2026-03",
    ]
    for start, end in [
        ("2026-10-02", "2026-10-01"),
        ("2024-01-01", "2025-01-01"),
        ("2026-02-29", "2026-03-01"),
    ]:
        with pytest.raises(ValueError):
            store.summary(start, end)


def test_demo_is_persistent_current_month_and_empty_only(tmp_path):
    store = new_store(tmp_path)
    assert store.meta() == {
        "name": "小本账",
        "currency": "CNY",
        "demo": False,
        "entry_count": 0,
        "payment_count": 0,
    }
    assert store.seed_demo() == {"ok": True}
    assert store.entries() and store.payments()
    assert all(
        entry["date"].startswith(date.today().strftime("%Y-%m")) for entry in store.entries()
    )
    assert new_store(tmp_path).meta()["demo"] is True
    count = len(store.entries())
    with pytest.raises(ValueError):
        store.seed_demo()
    assert len(store.entries()) == count


def test_api_security_validation_and_summary(tmp_path):
    from fastapi.testclient import TestClient

    from small_business_ledger.app import create_app

    client = TestClient(create_app(tmp_path / "http.db"), base_url="http://127.0.0.1:8000")
    headers = {"X-Ledger-Request": "1", "Origin": "http://127.0.0.1:8000"}
    assert client.get("/api/meta").status_code == 200
    assert client.get("/api/meta", headers={"Host": "evil.example"}).status_code == 403
    assert client.post("/api/entries", json=SALE).status_code == 403
    assert (
        client.post(
            "/api/entries", json=SALE, headers=headers | {"Origin": "http://evil.example"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/entries", json=SALE, headers=headers | {"Sec-Fetch-Site": "cross-site"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/entries", content="{}", headers=headers | {"Content-Type": "text/plain"}
        ).status_code
        == 415
    )
    assert (
        client.post("/api/entries", json=SALE | {"quantity": True}, headers=headers).status_code
        == 422
    )
    created = client.post("/api/entries", json=SALE, headers=headers)
    assert created.status_code == 201
    assert created.json()["revenue_cents"] == 3030
    summary = client.get("/api/summary?start=2026-10-01&end=2026-10-31")
    assert summary.status_code == 200 and summary.json()["profit_cents"] == 2415
    assert client.get("/api/nonexistent").status_code == 404
    assert client.get("/api/meta").headers["X-Content-Type-Options"] == "nosniff"
    too_big = client.post(
        "/api/demo",
        content=" " * (10 * 1024 * 1024 + 1),
        headers=headers | {"Content-Type": "application/json"},
    )
    assert too_big.status_code == 413


@pytest.mark.parametrize("kind", [[], {}, True, 1, None])
def test_invalid_kind_type_is_a_validation_error_not_a_server_failure(tmp_path, kind):
    store = new_store(tmp_path)
    with pytest.raises(ValueError):
        store.create_entry(SALE | {"kind": kind})
    with pytest.raises(ValueError):
        store.create_payment({"kind": kind, "date": "2026-10-01", "amount": "1"})
    assert store.meta()["entry_count"] == store.meta()["payment_count"] == 0


def test_invalid_unicode_is_rejected_before_sqlite_write(tmp_path):
    from small_business_ledger.store import LedgerError

    store = new_store(tmp_path)
    with pytest.raises(LedgerError) as error:
        store.create_entry(SALE | {"description": "invalid\ud800"})
    assert error.value.status_code == 422
    assert store.entries() == []


def test_record_limit_counts_entries_payments_and_void_records(tmp_path):
    store = new_store(tmp_path)
    sale = store.create_entry(SALE)
    store.void_entry(sale["id"], "更正")
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            "INSERT INTO payments(id,kind,entry_id,date,amount_cents,note,created_at,voided_at,void_reason) "
            "VALUES (?,'capital_in',NULL,'2026-10-01',1,'','2026-10-01T00:00:00Z',NULL,NULL)",
            [(f"00000000-0000-0000-0000-{number:012d}",) for number in range(9998)],
        )
    payment(store, None, "capital_in", "0.01")
    assert store.meta()["entry_count"] + store.meta()["payment_count"] == 10000
    with pytest.raises(ValueError) as error:
        store.create_entry(SALE)
    assert error.value.status_code == 409
    with pytest.raises(ValueError):
        payment(store, None, "capital_in", "0.01")


def test_concurrent_demo_initialization_is_single_atomic_batch(tmp_path):
    store = new_store(tmp_path)
    barrier = Barrier(2)

    def seed():
        barrier.wait()
        try:
            return store.seed_demo()
        except ValueError:
            return "rejected"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: seed(), range(2)))
    assert results.count({"ok": True}) == results.count("rejected") == 1
    assert store.meta() == {
        "name": "小本账",
        "currency": "CNY",
        "demo": True,
        "entry_count": 2,
        "payment_count": 4,
    }


def test_development_origin_is_opt_in_and_prod_rejects_other_loopback_ports(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from small_business_ledger.app import create_app

    monkeypatch.delenv("LEDGER_DEV", raising=False)
    headers = {"Origin": "http://127.0.0.1:5173", "X-Ledger-Request": "1"}
    production = TestClient(create_app(tmp_path / "prod.db"), base_url="http://127.0.0.1:8000")
    assert production.post("/api/entries", json=SALE, headers=headers).status_code == 403
    monkeypatch.setenv("LEDGER_DEV", "1")
    development = TestClient(create_app(tmp_path / "dev.db"), base_url="http://127.0.0.1:8000")
    assert development.post("/api/entries", json=SALE, headers=headers).status_code == 201
    assert (
        development.post(
            "/api/entries", json=SALE, headers=headers | {"Origin": "http://localhost:9999"}
        ).status_code
        == 403
    )
