import { useState } from "react";
import { ErrorMessage, Field, Modal, useSubmit } from "../components/Forms";
import { useCreateAttempt } from "../lib/useCreateAttempt";
import {
  formatMoney,
  localDate,
  parseMoney,
  saleTotals,
  validDate,
} from "../lib/money";
import type { EntryKind } from "../lib/types";
export function EntryDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<EntryKind>("sale"),
    [date, setDate] = useState(localDate),
    [description, setDescription] = useState(""),
    [category, setCategory] = useState("商品"),
    [quantity, setQuantity] = useState("1"),
    [price, setPrice] = useState(""),
    [cost, setCost] = useState(""),
    [amount, setAmount] = useState(""),
    [note, setNote] = useState(""),
    [customer, setCustomer] = useState(""),
    [supplier, setSupplier] = useState(""),
    [receivableDue, setReceivableDue] = useState(""),
    [payableDue, setPayableDue] = useState("");
  const { busy, error, run } = useSubmit();
  const { uncertain, submit } = useCreateAttempt("/entries");
  let totals: { revenue: number; cost: number } | null = null;
  try {
    if (price && cost) totals = saleTotals(quantity, price, cost);
  } catch {
    /* Preview waits for a valid amount; submit gives an actionable error. */
  }
  return (
    <Modal title="记一笔" onClose={onClose} busy={busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (uncertain) {
              await submit();
              onSaved();
              return;
            }
            if (!validDate(date)) throw new Error("请填写有效的业务发生日期");
            if (!description.trim() || !category.trim())
              throw new Error("请填写项目和分类");
            for (const due of [
              payableDue,
              ...(kind === "sale" ? [receivableDue] : []),
            ]) {
              if (due && (!validDate(due) || due < date))
                throw new Error("到期日须为有效日期，且不能早于业务日期");
            }
            const common = {
              kind,
              date,
              description: description.trim(),
              category: category.trim(),
              note: note.trim(),
              supplier: supplier.trim(),
              payable_due_date: payableDue || null,
            };
            if (kind === "sale") {
              saleTotals(quantity, price, cost);
              await submit({
                ...common,
                customer: customer.trim(),
                receivable_due_date: receivableDue || null,
                quantity: Number(quantity),
                unit_price: price.trim(),
                unit_cost: cost.trim(),
              });
            } else {
              if (parseMoney(amount) <= 0) throw new Error("费用金额须大于零");
              await submit({ ...common, amount: amount.trim() });
            }
            onSaved();
          });
        }}
      >
        <fieldset disabled={busy || uncertain} className="form-fields">
          <div className="segmented" role="group" aria-label="记录类型">
            {(["sale", "expense"] as const).map((value) => (
              <label key={value} className={kind === value ? "selected" : ""}>
                <input
                  type="radio"
                  name="entry-kind"
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                    setCategory(value === "sale" ? "商品" : "日常费用");
                  }}
                />
                {value === "sale" ? "销售" : "费用"}
              </label>
            ))}
          </div>
          <div className="form-grid">
            <Field
              label="日期"
              type="date"
              required
              min="2000-01-01"
              max="2100-12-31"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <Field
              label="分类"
              required
              maxLength={40}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <div className="full">
              <Field
                label="项目"
                autoFocus
                required
                maxLength={120}
                placeholder={
                  kind === "sale" ? "例如：帆布袋团购" : "例如：10 月房租"
                }
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {kind === "sale" ? (
              <>
                <Field
                  label="数量"
                  inputMode="numeric"
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                <Field
                  label="单价（元）"
                  inputMode="decimal"
                  required
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
                <Field
                  label="单位直接成本（元）"
                  inputMode="decimal"
                  required
                  placeholder="0.00"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
                <p className="field-hint">
                  填写已售数量对应的单位成本，不是全部进货款。
                </p>
              </>
            ) : (
              <div className="full">
                <Field
                  label="金额（元）"
                  inputMode="decimal"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            )}
            {kind === "sale" ? (
              <>
                <Field
                  label="客户（可选）"
                  maxLength={120}
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                />
                <Field
                  label="收款到期日（可选）"
                  type="date"
                  min={date}
                  max="2100-12-31"
                  value={receivableDue}
                  onChange={(e) => setReceivableDue(e.target.value)}
                />
              </>
            ) : null}
            <Field
              label="供应商 / 收款方（可选）"
              maxLength={120}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
            <Field
              label="付款到期日（可选）"
              type="date"
              min={date}
              max="2100-12-31"
              value={payableDue}
              onChange={(e) => setPayableDue(e.target.value)}
            />
            <label className="field full">
              备注（可选）
              <textarea
                maxLength={500}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          {kind === "sale" ? (
            <div className="calculation-preview" aria-live="polite">
              <span>
                销售额{" "}
                <strong className="money">
                  {totals ? `¥${formatMoney(totals.revenue)}` : "—"}
                </strong>
              </span>
              <span>
                直接成本{" "}
                <strong className="money">
                  {totals ? `¥${formatMoney(totals.cost)}` : "—"}
                </strong>
              </span>
            </div>
          ) : null}
          <p className="muted small">
            此处记录业务。实际收款或付款，请保存后到「收付款」登记。
          </p>
        </fieldset>
        <ErrorMessage message={error} />
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在保存…" : uncertain ? "重试原提交" : "保存记录"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
