import { useState } from "react";
import { ErrorMessage, Field, useSubmit } from "../components/Forms";
import { request } from "../lib/api";
import { formatMoney, localDate, parseMoney, validDate } from "../lib/money";
import { paymentLabels } from "../lib/types";
import type { Entry, PaymentKind } from "../lib/types";
export function PaymentForm({
  entries,
  onSaved,
  initialEntryId = "",
  initialKind = "receipt",
  onBusyChange,
}: {
  entries: Entry[];
  onSaved: () => void;
  initialEntryId?: string;
  initialKind?: PaymentKind;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [kind, setKind] = useState<PaymentKind>(initialKind),
    [entryId, setEntryId] = useState(initialEntryId),
    [date, setDate] = useState(() => {
      const selected = entries.find((e) => e.id === initialEntryId);
      return selected && selected.date > localDate()
        ? selected.date
        : localDate();
    }),
    [amount, setAmount] = useState(""),
    [note, setNote] = useState("");
  const { busy, error, run } = useSubmit(onBusyChange);
  const linked = kind !== "capital_in" && kind !== "capital_out";
  const eligible = entries.filter(
    (entry) =>
      !entry.voided_at &&
      entry.kind === (kind === "expense_payment" ? "expense" : "sale"),
  );
  const selected = eligible.find((entry) => entry.id === entryId);
  const remaining = selected
    ? kind === "receipt"
      ? selected.revenue_cents - selected.received_cents
      : kind === "cost_payment"
        ? selected.cost_cents - selected.paid_cents
        : selected.amount_cents - selected.paid_cents
    : 0;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!validDate(date)) throw new Error("请填写有效的实际收付日期");
          const cents = parseMoney(amount);
          if (cents <= 0) throw new Error("收付款金额须大于零");
          if (linked) {
            if (!selected) throw new Error("请选择有效的关联单据");
            if (date < selected.date)
              throw new Error("收付日期不能早于关联单据日期");
            if (cents > remaining)
              throw new Error("金额超过剩余可收或可付金额，请核对后重试");
          }
          await request("/payments", {
            kind,
            entry_id: linked ? entryId : null,
            date,
            amount: amount.trim(),
            note: note.trim(),
          });
          setAmount("");
          setNote("");
          onSaved();
        });
      }}
    >
      <fieldset disabled={busy} className="form-fields">
        <div className="form-grid">
          <label className="field">
            流水种类
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PaymentKind);
                setEntryId("");
              }}
            >
              {Object.entries(paymentLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="实际收付日期"
            type="date"
            required
            min={selected?.date ?? "2000-01-01"}
            max="2100-12-31"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          {linked ? (
            <>
              <label className="field full">
                关联单据
                <select
                  required
                  value={entryId}
                  onChange={(e) => {
                    setEntryId(e.target.value);
                  }}
                >
                  <option value="">请选择单据</option>
                  {eligible.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.date} · {entry.description} · ¥
                      {formatMoney(
                        kind === "cost_payment"
                          ? entry.cost_cents
                          : entry.amount_cents,
                      )}
                    </option>
                  ))}
                </select>
              </label>
              {selected ? (
                <p className="remaining full">
                  {kind === "receipt" ? "剩余可收" : "剩余可付"}：
                  <strong className="money">¥{formatMoney(remaining)}</strong>{" "}
                  <span className="muted">（按全部有效流水计算）</span>
                </p>
              ) : (
                <p className="muted small full">
                  {eligible.length
                    ? "选择单据后查看余额。"
                    : "暂无可关联单据，请先记录销售或费用。"}
                </p>
              )}
            </>
          ) : null}
          <Field
            label="金额（元）"
            inputMode="decimal"
            required
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
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
        <p className="muted small">
          本版不支持预收预付及销售前已支付的直接成本，请勿改写实际收付日期。
        </p>
      </fieldset>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          {busy ? "正在保存…" : "保存流水"}
        </button>
      </div>
    </form>
  );
}
