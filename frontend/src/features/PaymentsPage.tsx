import { useMemo, useState } from "react";
import { Field } from "../components/Forms";
import { formatMoney } from "../lib/money";
import { paymentLabels } from "../lib/types";
import type { Entry, Payment, PaymentKind } from "../lib/types";
import { PaymentForm } from "./PaymentForm";
import type { VoidTarget } from "./VoidDialog";
export function PaymentsPage({
  entries,
  payments,
  onSaved,
  onVoid,
}: {
  entries: Entry[];
  payments: Payment[];
  onSaved: () => void;
  onVoid: (target: VoidTarget) => void;
}) {
  const [showVoid, setShowVoid] = useState(false),
    [kind, setKind] = useState("all"),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const entryNames = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry.description])),
    [entries],
  );
  const visible = payments.filter(
    (payment) =>
      (showVoid || !payment.voided_at) &&
      (kind === "all" || payment.kind === kind) &&
      (!start || payment.date >= start) &&
      (!end || payment.date <= end),
  );
  return (
    <>
      <p className="page-note">
        按实际收付日期记流水，可分次收付。期初资金可记为一笔「资金投入」。
      </p>
      <section className="panel payment-entry">
        <h2>登记收付款</h2>
        <PaymentForm entries={entries} onSaved={onSaved} />
      </section>
      <div className="filters">
        <label className="field">
          流水筛选
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">全部种类</option>
            {Object.entries(paymentLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="收付开始日期"
          type="date"
          min="2000-01-01"
          max="2100-12-31"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <Field
          label="收付截止日期"
          type="date"
          min="2000-01-01"
          max="2100-12-31"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showVoid}
            onChange={(e) => setShowVoid(e.target.checked)}
          />
          查看作废流水
        </label>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>收付款流水</h2>
          <span className="muted">{visible.length} 条</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>种类 / 关联项目</th>
                <th>方向</th>
                <th className="numeric">金额（元）</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((payment) => {
                const incoming = (
                  ["receipt", "capital_in"] as PaymentKind[]
                ).includes(payment.kind);
                return (
                  <tr
                    key={payment.id}
                    className={payment.voided_at ? "voided-row" : ""}
                  >
                    <td className="nowrap">{payment.date}</td>
                    <td className="description-cell">
                      {paymentLabels[payment.kind]}
                      {payment.entry_id ? (
                        <span className="cell-subtext">
                          {entryNames.get(payment.entry_id) ?? "关联单据"}
                        </span>
                      ) : null}
                      {payment.voided_at ? (
                        <span className="status-tag">已作废</span>
                      ) : null}
                    </td>
                    <td className={incoming ? "accent" : ""}>
                      {incoming ? "收入" : "支出"}
                    </td>
                    <td className="money numeric">
                      {formatMoney(payment.amount_cents)}
                    </td>
                    <td className="note-cell">
                      {payment.note || "—"}
                      {payment.voided_at ? (
                        <span className="cell-subtext">
                          作废原因：{payment.void_reason}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {payment.voided_at ? (
                        <span className="muted">已作废</span>
                      ) : (
                        <button
                          className="link-button danger-text"
                          onClick={() =>
                            onVoid({
                              resource: "payments",
                              id: payment.id,
                              description: `${paymentLabels[payment.kind]} ¥${formatMoney(payment.amount_cents)}`,
                            })
                          }
                        >
                          作废流水
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 ? (
          <p className="empty-state muted">
            暂无符合条件的流水。请在上方登记实际收款或付款。
          </p>
        ) : null}
      </section>
    </>
  );
}
