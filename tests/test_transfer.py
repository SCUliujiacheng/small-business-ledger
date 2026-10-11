"""Migration tests use hand-checked values and real SQLite transactions."""

import copy
import csv
import io
from concurrent.futures import ThreadPoolExecutor

import pytest

from small_business_ledger.store import LedgerError, Store
from small_business_ledger.transfer import (
    commit_csv,
    export_entries,
    make_backup,
    preview_csv,
    restore_backup,
)


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "source.db")


CSV = "external_id,kind,date,description,category,quantity,unit_price,unit_cost,amount,note\ns-1,sale,2026-10-01,帆布袋,商品,3,0.10,0.03,,试录\ne-1,expense,2026-10-02,房租,房租,,,,20.00,\n"


def test_preview_is_read_only_and_cent_exact(store):
    result = preview_csv(store, CSV)
    assert result["count"] == 2
    assert result["errors"] == []
    assert result["rows"][0]["unit_price"] == "0.10"
    assert store.entries() == []


def test_commit_all_rows_and_reject_repeat(store):
    assert commit_csv(store, CSV) == {"imported": 2}
    sale = next(e for e in store.entries() if e["kind"] == "sale")
    assert sale["revenue_cents"] == 30
    assert sale["cost_cents"] == 9
    with pytest.raises(LedgerError):
        commit_csv(store, CSV)
    assert len(store.entries()) == 2


@pytest.mark.parametrize(
    "bad",
    [
        CSV.replace("20.00", "20.001"),
        CSV.replace("e-1,expense", "s-1,expense"),
        CSV.replace("s-1,sale", ",sale"),
        CSV.replace("3,0.10", "3.5,0.10"),
        CSV.replace("2026-10-02", "2026-02-30"),
        CSV.replace("e-1,expense", "e-1,unknown"),
        CSV.replace("amount,note", "amount,unexpected"),
    ],
)
def test_bad_import_has_no_partial_writes(store, bad):
    assert preview_csv(store, bad)["errors"]
    with pytest.raises(LedgerError):
        commit_csv(store, bad)
    assert store.entries() == []


def test_concurrent_import_cannot_duplicate(store):
    def run():
        try:
            return commit_csv(store, CSV)["imported"]
        except LedgerError:
            return 0

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: run(), range(2))) == [0, 2]
    assert len(store.entries()) == 2


@pytest.mark.parametrize("description", ["=1+1", "  @SUM(1)", "'+original", "普通项目", "\t=1+1"])
def test_csv_formula_escaping_round_trip(store, tmp_path, description):
    store.create_entry(
        {
            "kind": "expense",
            "date": "2026-10-02",
            "description": description,
            "category": "杂项",
            "amount": "1.20",
        }
    )
    original = store.entries()[0]["description"]
    output = export_entries(store)
    rows = list(csv.DictReader(io.StringIO(output.lstrip("\ufeff"))))
    if original.lstrip().startswith(("=", "+", "-", "@", "'")):
        assert rows[0]["description"].startswith("'")
    target = Store(tmp_path / "target.db")
    commit_csv(target, output)
    assert target.entries()[0]["description"] == original


def test_exported_void_entries_cannot_be_reimported(store):
    commit_csv(store, CSV)
    store.void_entry(store.entries()[0]["id"], "重复录入")
    assert preview_csv(store, export_entries(store))["errors"]


def test_exported_manual_entry_is_duplicate_in_original_ledger(store):
    store.create_entry(
        {
            "kind": "expense",
            "date": "2026-10-02",
            "description": "房租",
            "category": "房租",
            "amount": "100.00",
        }
    )
    exported = export_entries(store)
    assert preview_csv(store, exported)["errors"]
    with pytest.raises(LedgerError):
        commit_csv(store, exported)
    assert len(store.entries()) == 1


def seed_with_payment(store):
    commit_csv(store, CSV)
    sale = next(e for e in store.entries() if e["kind"] == "sale")
    store.create_payment(
        {"kind": "receipt", "entry_id": sale["id"], "date": "2026-10-03", "amount": "0.20"}
    )


def test_backup_restore_preserves_ids_metadata_and_reports(store, tmp_path):
    seed_with_payment(store)
    expense = next(e for e in store.entries() if e["kind"] == "expense")
    store.void_entry(expense["id"], "重复录入")
    backup = make_backup(store)
    target = Store(tmp_path / "restored.db")
    assert restore_backup(target, backup) == {"restored_entries": 2, "restored_payments": 1}
    assert target.entries() == store.entries()
    assert target.payments() == store.payments()
    assert target.summary("2026-10-01", "2026-10-31") == store.summary("2026-10-01", "2026-10-31")


def test_restore_never_overwrites_even_void_only_db(store):
    commit_csv(store, CSV)
    backup = make_backup(store)
    for e in store.entries():
        store.void_entry(e["id"], "错误")
    with pytest.raises(LedgerError):
        restore_backup(store, backup)
    assert all(e["voided_at"] for e in store.entries())


@pytest.mark.parametrize(
    "mutation",
    [
        lambda b: b.update(version=True),
        lambda b: b.update(currency="USD"),
        lambda b: b.update(demo="false"),
        lambda b: b["entries"][0].update(amount_cents=1.5),
        lambda b: b["entries"][0].update(amount_cents=True),
        lambda b: b["entries"][0].update(created_at="not-a-date"),
        lambda b: b["entries"][0].update(voided_at="2026-10-01T00:00:00Z", void_reason=""),
        lambda b: b["entries"].append(copy.deepcopy(b["entries"][0])),
        lambda b: b["payments"][0].update(amount_cents=31),
        lambda b: b["payments"][0].update(date="2026-09-01"),
        lambda b: b["payments"][0].update(entry_id="00000000-0000-0000-0000-000000000000"),
        lambda b: b["payments"][0].update(kind="expense_payment"),
    ],
)
def test_corrupt_backup_rejected_without_partial_restore(store, tmp_path, mutation):
    seed_with_payment(store)
    backup = make_backup(store)
    mutation(backup)
    target = Store(tmp_path / "target.db")
    with pytest.raises(LedgerError):
        restore_backup(target, backup)
    assert target.entries() == []
    assert target.payments() == []


def test_size_limit_checked_before_parse(store):
    result = preview_csv(store, "x" * (2 * 1024 * 1024 + 1))
    assert result["errors"]


def test_invalid_unicode_csv_is_validation_error_not_server_error(store):
    assert preview_csv(store, CSV.replace("帆布袋", chr(0xD800)))["errors"]


def test_raw_csv_keeps_original_apostrophe(store):
    commit_csv(store, CSV.replace("帆布袋", "'=1+1"))
    assert next(e for e in store.entries() if e["kind"] == "sale")["description"] == "'=1+1"


def test_restore_rejects_combined_overpayment(store, tmp_path):
    from uuid import uuid4

    seed_with_payment(store)
    backup = make_backup(store)
    payment = {**backup["payments"][0], "id": str(uuid4())}
    backup["payments"].append(payment)
    target = Store(tmp_path / "target.db")
    with pytest.raises(LedgerError, match="累计"):
        restore_backup(target, backup)
    assert target.meta()["entry_count"] == 0


def test_restore_rejects_active_payment_of_void_entry(store, tmp_path):
    seed_with_payment(store)
    backup = make_backup(store)
    sale = next(e for e in backup["entries"] if e["kind"] == "sale")
    sale.update(voided_at=backup["exported_at"], void_reason="不当作废")
    target = Store(tmp_path / "target.db")
    with pytest.raises(LedgerError, match="有效流水"):
        restore_backup(target, backup)
    assert target.meta()["entry_count"] == 0


@pytest.mark.parametrize("field", ["revenue_cents", "cost_cents", "amount_cents"])
def test_restore_recalculates_sale_totals(store, tmp_path, field):
    seed_with_payment(store)
    backup = make_backup(store)
    sale = next(e for e in backup["entries"] if e["kind"] == "sale")
    sale[field] += 1
    target = Store(tmp_path / "target.db")
    with pytest.raises(LedgerError, match="重新计算"):
        restore_backup(target, backup)
    assert target.meta()["entry_count"] == 0
