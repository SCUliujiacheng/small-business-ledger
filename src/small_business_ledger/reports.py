"""Read-only reports; business events and cash settlements have separate dates."""

from datetime import date

from .models import ValidationError, validate_date


def outstanding(entries, payments, as_of):
    """Unsettled active obligations using business and payment dates up to the cutoff."""
    as_of = validate_date(as_of)
    cutoff = date.fromisoformat(as_of)
    settled = {}
    for payment in payments:
        if payment["voided_at"] or payment["date"] > as_of:
            continue
        key = (payment["entry_id"], payment["kind"])
        settled[key] = settled.get(key, 0) + payment["amount_cents"]

    totals = dict.fromkeys(
        [
            "receivable_cents",
            "payable_cents",
            "overdue_receivable_cents",
            "overdue_payable_cents",
        ],
        0,
    )
    items = []
    for entry in entries:
        if entry["voided_at"] or entry["date"] > as_of:
            continue
        obligations = (
            [
                ("receipt", "revenue_cents", "customer", "receivable_due_date"),
                ("cost_payment", "cost_cents", "supplier", "payable_due_date"),
            ]
            if entry["kind"] == "sale"
            else [("expense_payment", "amount_cents", "supplier", "payable_due_date")]
        )
        for kind, amount_field, counterparty_field, due_field in obligations:
            original = entry[amount_field]
            paid = settled.get((entry["id"], kind), 0)
            balance = original - paid
            if balance <= 0:
                continue
            due = entry.get(due_field)
            overdue_days = max(0, (cutoff - date.fromisoformat(due)).days) if due else 0
            status = (
                "no_due_date"
                if due is None
                else "overdue"
                if due < as_of
                else "due_today"
                if due == as_of
                else "upcoming"
            )
            side = "receivable_cents" if kind == "receipt" else "payable_cents"
            totals[side] += balance
            if overdue_days:
                totals["overdue_" + side] += balance
            items.append(
                {
                    "entry_id": entry["id"],
                    "kind": kind,
                    "date": entry["date"],
                    "description": entry["description"],
                    "category": entry["category"],
                    "counterparty": entry.get(counterparty_field, ""),
                    "due_date": due,
                    "outstanding_cents": balance,
                    "original_cents": original,
                    "settled_cents": paid,
                    "overdue_days": overdue_days,
                    "status": status,
                }
            )
    items.sort(
        key=lambda item: (
            item["due_date"] is None,
            item["due_date"] or "",
            item["date"],
            item["entry_id"],
            item["kind"],
        )
    )
    return {"as_of": as_of, **totals, "items": items}


def summarize(entries, payments, start, end):
    start, end = validate_date(start), validate_date(end)
    days = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1
    if not 1 <= days <= 366:
        raise ValidationError("开始日期不能晚于结束日期，范围最多 366 天")
    totals = dict.fromkeys(
        [
            "revenue_cents",
            "cost_cents",
            "gross_profit_cents",
            "expense_cents",
            "profit_cents",
            "cash_in_cents",
            "cash_out_cents",
            "net_cash_cents",
            "balance_cents",
            "receivable_cents",
            "payable_cents",
            "entry_count",
        ],
        0,
    )
    months = {}
    year, month = int(start[:4]), int(start[5:7])
    while f"{year:04d}-{month:02d}" <= end[:7]:
        key = f"{year:04d}-{month:02d}"
        months[key] = {
            "month": key,
            **dict.fromkeys(
                [
                    "revenue_cents",
                    "cost_cents",
                    "expense_cents",
                    "profit_cents",
                    "cash_in_cents",
                    "cash_out_cents",
                ],
                0,
            ),
        }
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)

    for entry in entries:
        if entry["voided_at"] or entry["date"] > end:
            continue
        sale = entry["kind"] == "sale"
        totals["receivable_cents"] += entry["revenue_cents"] if sale else 0
        totals["payable_cents"] += entry["cost_cents"] if sale else entry["amount_cents"]
        if entry["date"] >= start:
            totals["entry_count"] += 1
            monthly = months[entry["date"][:7]]
            for key, value in {
                "revenue_cents": entry["revenue_cents"],
                "cost_cents": entry["cost_cents"],
                "expense_cents": 0 if sale else entry["amount_cents"],
            }.items():
                totals[key] += value
                monthly[key] += value

    for payment in payments:
        if payment["voided_at"] or payment["date"] > end:
            continue
        amount, kind = payment["amount_cents"], payment["kind"]
        inflow = kind in {"receipt", "capital_in"}
        totals["balance_cents"] += amount if inflow else -amount
        if kind == "receipt":
            totals["receivable_cents"] -= amount
        elif kind in {"cost_payment", "expense_payment"}:
            totals["payable_cents"] -= amount
        if payment["date"] >= start:
            key = "cash_in_cents" if inflow else "cash_out_cents"
            totals[key] += amount
            months[payment["date"][:7]][key] += amount

    totals["gross_profit_cents"] = totals["revenue_cents"] - totals["cost_cents"]
    totals["profit_cents"] = totals["gross_profit_cents"] - totals["expense_cents"]
    totals["net_cash_cents"] = totals["cash_in_cents"] - totals["cash_out_cents"]
    for monthly in months.values():
        monthly["profit_cents"] = (
            monthly["revenue_cents"] - monthly["cost_cents"] - monthly["expense_cents"]
        )
    return {"start": start, "end": end, **totals, "monthly": list(months.values())}
