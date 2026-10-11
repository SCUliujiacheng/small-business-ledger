"""Strict input validation shared by online entry, CSV imports and restore."""

import hashlib
import json
import re
from datetime import date
from uuid import UUID

MAX_AMOUNT_CENTS = 10_000_000_000
MAX_RECORDS = 10_000
ENTRY_KINDS = {"sale", "expense"}
PAYMENT_KINDS = {"receipt", "cost_payment", "expense_payment", "capital_in", "capital_out"}


class ValidationError(ValueError):
    """User data does not satisfy the ledger's input contract."""


def payload_digest(validated):
    """Stable identity of the normalized create payload, shared by writes and restore."""
    encoded = json.dumps(
        validated, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_text(value, field, min_length=0, max_length=500):
    if not isinstance(value, str):
        raise ValidationError(f"{field}必须是文本")
    if not min_length <= len(value) <= max_length or (min_length and not value.strip()):
        raise ValidationError(f"{field}长度须为 {min_length}..{max_length} 字，且不能全为空白")
    if "\x00" in value:
        raise ValidationError(f"{field}不能包含空字符")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValidationError(f"{field}包含无效的 Unicode 字符") from exc
    return value


def validate_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValidationError("日期须为 YYYY-MM-DD 格式")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError("日期不存在") from exc
    if not 2000 <= parsed.year <= 2100:
        raise ValidationError("日期须在 2000..2100 年内")
    return value


def validate_uuid(value, field="id"):
    if not isinstance(value, str):
        raise ValidationError(f"{field}须为 UUID 文本")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValidationError(f"{field}须为 UUID 文本") from exc
    if str(parsed) != value:
        raise ValidationError(f"{field}须为标准小写 UUID 格式")
    return value


def parse_money(value, positive=False):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,9}(?:\.[0-9]{1,2})?", value):
        raise ValidationError("金额须为非负十进制文本，最多两位小数")
    whole, _, fraction = value.partition(".")
    cents = int(whole) * 100 + int(fraction.ljust(2, "0") or "0")
    if cents > MAX_AMOUNT_CENTS or (positive and cents == 0):
        raise ValidationError(
            "金额须大于零且不超过 100,000,000 元" if positive else "金额不能超过 100,000,000 元"
        )
    return cents


def _object(payload, required, allowed):
    if not isinstance(payload, dict):
        raise ValidationError("请求内容须为 JSON 对象")
    if set(payload) - allowed:
        raise ValidationError("包含不支持的字段")
    if required - set(payload):
        raise ValidationError("缺少必填字段：" + "、".join(sorted(required - set(payload))))


def validate_entry(payload):
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("kind"), str)
        or payload["kind"] not in ENTRY_KINDS
    ):
        raise ValidationError("单据类型须为 sale 或 expense")
    common = {"kind", "date", "description", "category"}
    required = common | (
        {"quantity", "unit_price", "unit_cost"} if payload["kind"] == "sale" else {"amount"}
    )
    _object(
        payload,
        required,
        required
        | {
            "note",
            "external_id",
            "customer",
            "supplier",
            "receivable_due_date",
            "payable_due_date",
        },
    )
    external_id = payload.get("external_id")
    if external_id is not None:
        external_id = validate_text(external_id, "外部编号", 1, 80)
    result = {
        "kind": payload["kind"],
        "date": validate_date(payload["date"]),
        "description": validate_text(payload["description"], "项目说明", 1, 120),
        "category": validate_text(payload["category"], "分类", 1, 40),
        "quantity": None,
        "unit_price_cents": None,
        "unit_cost_cents": None,
        "revenue_cents": 0,
        "cost_cents": 0,
        "amount_cents": 0,
        "note": validate_text(payload.get("note", ""), "备注", 0, 500),
        "external_id": external_id,
        "customer": validate_text(payload.get("customer", ""), "客户", 0, 120),
        "supplier": validate_text(payload.get("supplier", ""), "供应商/收款方", 0, 120),
    }
    for field in ("receivable_due_date", "payable_due_date"):
        due_date = payload.get(field)
        if due_date is not None:
            due_date = validate_date(due_date)
            if due_date < result["date"]:
                raise ValidationError("到期日不能早于业务日期")
        result[field] = due_date
    if payload["kind"] == "expense" and (
        result["customer"] or result["receivable_due_date"] is not None
    ):
        raise ValidationError("费用不能填写客户或收款到期日")
    if payload["kind"] == "sale":
        quantity = payload["quantity"]
        if type(quantity) is not int or not 1 <= quantity <= 1_000_000:
            raise ValidationError("数量须为 1..1,000,000 的整数")
        unit_price = parse_money(payload["unit_price"])
        unit_cost = parse_money(payload["unit_cost"])
        revenue, cost = quantity * unit_price, quantity * unit_cost
        if max(revenue, cost) > MAX_AMOUNT_CENTS:
            raise ValidationError("单条销售额或直接成本不能超过 100,000,000 元")
        result.update(
            quantity=quantity,
            unit_price_cents=unit_price,
            unit_cost_cents=unit_cost,
            revenue_cents=revenue,
            cost_cents=cost,
            amount_cents=revenue,
        )
    else:
        result["amount_cents"] = parse_money(payload["amount"], positive=True)
    return result


def validate_payment(payload):
    required = {"kind", "date", "amount"}
    _object(payload, required, required | {"entry_id", "note"})
    if not isinstance(payload["kind"], str) or payload["kind"] not in PAYMENT_KINDS:
        raise ValidationError("流水类型不受支持")
    kind, entry_id = payload["kind"], payload.get("entry_id")
    if kind in {"capital_in", "capital_out"}:
        if entry_id is not None:
            raise ValidationError("资金投入和取出不能关联单据")
    else:
        entry_id = validate_uuid(entry_id, "关联单据编号")
    return {
        "kind": kind,
        "entry_id": entry_id,
        "date": validate_date(payload["date"]),
        "amount_cents": parse_money(payload["amount"], positive=True),
        "note": validate_text(payload.get("note", ""), "备注", 0, 500),
    }
