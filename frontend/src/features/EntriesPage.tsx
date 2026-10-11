import { Fragment, useState } from "react";
import { Field } from "../components/Forms";
import { formatMoney } from "../lib/money";
import type { Entry, PaymentKind } from "../lib/types";
import type { VoidTarget } from "./VoidDialog";
export function EntriesPage({
  entries,
  onPayment,
  onVoid,
}: {
  entries: Entry[];
  onPayment: (entry: Entry, kind: PaymentKind) => void;
  onVoid: (target: VoidTarget) => void;
}) {
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [showVoid, setShowVoid] = useState(false),
    [expanded, setExpanded] = useState<string | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = entries.filter(
    (entry) =>
      (showVoid || !entry.voided_at) &&
      (kind === "all" || entry.kind === kind) &&
      (!start || entry.date >= start) &&
      (!end || entry.date <= end) &&
      (!normalized ||
        `${entry.description} ${entry.category} ${entry.customer} ${entry.supplier} ${entry.external_id ?? ""} ${entry.note}`
          .toLocaleLowerCase()
          .includes(normalized)),
  );
  return (
    <>
      <p className="page-note">
        按业务发生日期记账。销售中的直接成本，请勿在日常费用里重复记录。
      </p>
      <div className="filters">
        <label className="field">
          类型
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">全部类型</option>
            <option value="sale">销售</option>
            <option value="expense">费用</option>
          </select>
        </label>
        <Field
          label="检索项目或分类"
          type="search"
          placeholder="项目、分类、往来、导入编号或备注"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Field
          label="业务开始日期"
          type="date"
          min="2000-01-01"
          max="2100-12-31"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <Field
          label="业务截止日期"
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
          查看作废记录
        </label>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>业务记录</h2>
          <span className="muted">{visible.length} 条</span>
        </div>
        <div className="table-scroll">
          <table className="entries-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>项目</th>
                <th>类型</th>
                <th className="numeric">金额（元）</th>
                <th>累计已收 / 已付</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <Fragment key={entry.id}>
                  <tr className={entry.voided_at ? "voided-row" : ""}>
                    <td className="nowrap">{entry.date}</td>
                    <td className="description-cell">
                      {entry.description}
                      {entry.voided_at ? (
                        <span className="status-tag">已作废</span>
                      ) : null}
                    </td>
                    <td>{entry.kind === "sale" ? "销售" : "费用"}</td>
                    <td className="money numeric">
                      {formatMoney(entry.amount_cents)}
                    </td>
                    <td className="small">
                      {entry.kind === "sale" ? (
                        <>
                          <span className="nowrap">
                            收{" "}
                            <span className="money">
                              {formatMoney(entry.received_cents)}
                            </span>
                          </span>
                          <br />
                          <span className="nowrap muted">
                            成本付{" "}
                            <span className="money">
                              {formatMoney(entry.paid_cents)}
                            </span>
                          </span>
                        </>
                      ) : (
                        <span className="nowrap">
                          付{" "}
                          <span className="money">
                            {formatMoney(entry.paid_cents)}
                          </span>
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        className="link-button"
                        aria-expanded={expanded === entry.id}
                        aria-controls={`entry-${entry.id}`}
                        onClick={() =>
                          setExpanded(expanded === entry.id ? null : entry.id)
                        }
                      >
                        {expanded === entry.id ? "收起" : "详情"}
                      </button>
                    </td>
                  </tr>
                  {expanded === entry.id ? (
                    <tr id={`entry-${entry.id}`}>
                      <td colSpan={6} className="detail-cell">
                        <dl className="record-details">
                          <div>
                            <dt>分类</dt>
                            <dd>{entry.category}</dd>
                          </div>
                          {entry.kind === "sale" ? (
                            <>
                              <div>
                                <dt>客户</dt>
                                <dd>{entry.customer || "未填写"}</dd>
                              </div>
                              <div>
                                <dt>收款到期日</dt>
                                <dd>
                                  {entry.receivable_due_date || "未设到期日"}
                                </dd>
                              </div>
                            </>
                          ) : null}
                          <div>
                            <dt>供应商 / 收款方</dt>
                            <dd>{entry.supplier || "未填写"}</dd>
                          </div>
                          <div>
                            <dt>付款到期日</dt>
                            <dd>{entry.payable_due_date || "未设到期日"}</dd>
                          </div>
                          {entry.kind === "sale" ? (
                            <>
                              <div>
                                <dt>数量 × 单价</dt>
                                <dd className="money">
                                  {entry.quantity} × ¥
                                  {formatMoney(entry.unit_price_cents ?? 0)}
                                </dd>
                              </div>
                              <div>
                                <dt>直接成本</dt>
                                <dd className="money">
                                  ¥{formatMoney(entry.cost_cents)}{" "}
                                  <span className="muted">
                                    （单位 ¥
                                    {formatMoney(entry.unit_cost_cents ?? 0)}）
                                  </span>
                                </dd>
                              </div>
                              <div>
                                <dt>未收 / 成本未付</dt>
                                <dd className="money">
                                  ¥
                                  {formatMoney(
                                    entry.revenue_cents - entry.received_cents,
                                  )}{" "}
                                  / ¥
                                  {formatMoney(
                                    entry.cost_cents - entry.paid_cents,
                                  )}
                                </dd>
                              </div>
                            </>
                          ) : (
                            <div>
                              <dt>未付款</dt>
                              <dd className="money">
                                ¥
                                {formatMoney(
                                  entry.amount_cents - entry.paid_cents,
                                )}
                              </dd>
                            </div>
                          )}
                          {entry.note ? (
                            <div className="full">
                              <dt>备注</dt>
                              <dd>{entry.note}</dd>
                            </div>
                          ) : null}
                          {entry.external_id ? (
                            <div>
                              <dt>导入编号</dt>
                              <dd>{entry.external_id}</dd>
                            </div>
                          ) : null}
                          {entry.voided_at ? (
                            <div className="full">
                              <dt>作废原因</dt>
                              <dd>{entry.void_reason}</dd>
                            </div>
                          ) : null}
                        </dl>
                        {!entry.voided_at ? (
                          <div className="row-actions">
                            {entry.kind === "sale" ? (
                              <>
                                <button
                                  disabled={
                                    entry.received_cents >= entry.revenue_cents
                                  }
                                  onClick={() => onPayment(entry, "receipt")}
                                >
                                  登记收款
                                </button>
                                <button
                                  disabled={
                                    entry.paid_cents >= entry.cost_cents
                                  }
                                  onClick={() =>
                                    onPayment(entry, "cost_payment")
                                  }
                                >
                                  登记成本付款
                                </button>
                              </>
                            ) : (
                              <button
                                disabled={
                                  entry.paid_cents >= entry.amount_cents
                                }
                                onClick={() =>
                                  onPayment(entry, "expense_payment")
                                }
                              >
                                登记付款
                              </button>
                            )}
                            <button
                              className="danger-link"
                              onClick={() =>
                                onVoid({
                                  resource: "entries",
                                  id: entry.id,
                                  description: entry.description,
                                })
                              }
                            >
                              作废记录
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 ? (
          <div className="empty-state">
            <p>没有符合条件的记录</p>
            <p className="muted small">
              可调整筛选条件，或点击「记一笔」添加销售与费用。
            </p>
          </div>
        ) : null}
        <p className="muted small table-footnote">
          累计已收 / 已付按全部有效关联流水计算，不受此页日期筛选限制。
        </p>
      </section>
    </>
  );
}
