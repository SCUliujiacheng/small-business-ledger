"""Hand-checked dated obligations, independently from present-day settlements."""

import copy

import pytest

from small_business_ledger import reports
from small_business_ledger.models import ValidationError, validate_entry

SALE = {
    "kind": "sale",
    "date": "2026-10-01",
    "description": "订单",
    "category": "商品",
    "quantity": 2,
    "unit_price": "50",
    "unit_cost": "20",
}


def test_optional_counterparties_default_without_changing_amounts():
    row = validate_entry(SALE)
    assert {
        key: row.get(key)
        for key in ("customer", "supplier", "receivable_due_date", "payable_due_date")
    } == {"customer": "", "supplier": "", "receivable_due_date": None, "payable_due_date": None}
    assert (row["revenue_cents"], row["cost_cents"]) == (10000, 4000)


def test_sale_has_independent_customer_supplier_and_due_dates():
    details = {
        "customer": "客户甲",
        "supplier": "工厂乙",
        "receivable_due_date": "2026-10-01",
        "payable_due_date": "2026-11-01",
    }
    row = validate_entry(SALE | details)
    assert {key: row[key] for key in details} == details


@pytest.mark.parametrize(
    "details",
    [
        {"customer": "长" * 121},
        {"supplier": None},
        {"customer": "\x00"},
        {"receivable_due_date": "2026-09-30"},
        {"payable_due_date": "2026-09-30"},
        {"receivable_due_date": "2026-02-30"},
        {"payable_due_date": ""},
    ],
)
def test_counterparty_and_due_date_validation(details):
    with pytest.raises(ValidationError):
        validate_entry(SALE | details)


@pytest.mark.parametrize(
    "details",
    [
        {"customer": "客户甲"},
        {"receivable_due_date": "2026-10-10"},
    ],
)
def test_expense_cannot_create_customer_receivable(details):
    with pytest.raises(ValidationError):
        validate_entry(
            {
                "kind": "expense",
                "date": "2026-10-01",
                "description": "房租",
                "category": "租金",
                "amount": "10",
            }
            | details
        )


def test_expense_accepts_payable_details_and_empty_receivable_fields():
    row = validate_entry(
        {
            "kind": "expense",
            "date": "2026-10-01",
            "description": "房租",
            "category": "租金",
            "amount": "10",
            "supplier": "房东",
            "customer": "",
            "receivable_due_date": None,
            "payable_due_date": "2026-10-10",
        }
    )
    assert (row["supplier"], row["payable_due_date"]) == ("房东", "2026-10-10")


def obligation(entry_id, **overrides):
    return {
        "id": entry_id,
        "kind": "sale",
        "date": "2026-10-01",
        "description": "订单",
        "category": "商品",
        "revenue_cents": 10000,
        "cost_cents": 4000,
        "amount_cents": 10000,
        "voided_at": None,
        "customer": "客户甲",
        "supplier": "工厂乙",
        "receivable_due_date": "2026-10-05",
        "payable_due_date": "2026-10-10",
        **overrides,
    }


def settlement(entry_id, kind, amount, day="2026-10-03", **overrides):
    return {
        "entry_id": entry_id,
        "kind": kind,
        "amount_cents": amount,
        "date": day,
        "voided_at": None,
        **overrides,
    }


def test_outstanding_cutoff_separates_sale_sides_and_matches_summary():
    entries = [
        obligation("sale"),
        obligation(
            "expense",
            kind="expense",
            revenue_cents=0,
            cost_cents=0,
            amount_cents=3000,
            customer="",
            supplier="房东",
            receivable_due_date=None,
            payable_due_date=None,
        ),
        obligation("future", date="2026-10-20"),
        obligation("void", voided_at="2026-10-06T00:00:00+00:00"),
        obligation("zero", revenue_cents=0, cost_cents=0, amount_cents=0),
    ]
    payments = [
        settlement("sale", "receipt", 2500),
        settlement("sale", "cost_payment", 1000),
        settlement("sale", "receipt", 7500, "2026-10-20"),
        settlement("sale", "cost_payment", 3000, "2026-10-20"),
        settlement("expense", "expense_payment", 500),
        settlement("sale", "receipt", 1000, voided_at="2026-10-04T00:00:00+00:00"),
        settlement(None, "capital_in", 50000),
    ]
    original = copy.deepcopy((entries, payments))
    report = getattr(reports, "outstanding", lambda *_: None)(entries, payments, "2026-10-10")
    assert report is not None, "outstanding report is not implemented"
    assert report == {
        "as_of": "2026-10-10",
        "receivable_cents": 7500,
        "payable_cents": 5500,
        "overdue_receivable_cents": 7500,
        "overdue_payable_cents": 0,
        "items": [
            {
                "entry_id": "sale",
                "kind": "receipt",
                "date": "2026-10-01",
                "description": "订单",
                "category": "商品",
                "counterparty": "客户甲",
                "due_date": "2026-10-05",
                "outstanding_cents": 7500,
                "original_cents": 10000,
                "settled_cents": 2500,
                "overdue_days": 5,
                "status": "overdue",
            },
            {
                "entry_id": "sale",
                "kind": "cost_payment",
                "date": "2026-10-01",
                "description": "订单",
                "category": "商品",
                "counterparty": "工厂乙",
                "due_date": "2026-10-10",
                "outstanding_cents": 3000,
                "original_cents": 4000,
                "settled_cents": 1000,
                "overdue_days": 0,
                "status": "due_today",
            },
            {
                "entry_id": "expense",
                "kind": "expense_payment",
                "date": "2026-10-01",
                "description": "订单",
                "category": "商品",
                "counterparty": "房东",
                "due_date": None,
                "outstanding_cents": 2500,
                "original_cents": 3000,
                "settled_cents": 500,
                "overdue_days": 0,
                "status": "no_due_date",
            },
        ],
    }
    summary = reports.summarize(entries, payments, "2026-10-01", "2026-10-10")
    assert report["receivable_cents"] == summary["receivable_cents"]
    assert report["payable_cents"] == summary["payable_cents"]
    assert (entries, payments) == original


def test_outstanding_zero_balances_disappear_and_upcoming_is_not_overdue():
    entries = [obligation("b", payable_due_date="2026-10-11"), obligation("a")]
    payments = [settlement("a", "receipt", 10000), settlement("a", "cost_payment", 4000)]
    report = getattr(reports, "outstanding", lambda *_: None)(entries, payments, "2026-10-04")
    assert report is not None, "outstanding report is not implemented"
    assert [(r["entry_id"], r["status"]) for r in report["items"]] == [
        ("b", "upcoming"),
        ("b", "upcoming"),
    ]
    assert (report["overdue_receivable_cents"], report["overdue_payable_cents"]) == (0, 0)


def test_outstanding_rejects_invalid_cutoff():
    with pytest.raises(ValidationError):
        getattr(reports, "outstanding", lambda *_: None)([], [], "2026-02-30")
