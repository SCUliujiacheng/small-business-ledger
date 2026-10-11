import { useEffect, useMemo, useState } from "react";
import { ErrorMessage, Field } from "../components/Forms";
import { errorMessage, request } from "../lib/api";
import { formatMoney, localDate, validDate } from "../lib/money";
import { paymentLabels } from "../lib/types";
import type { Entry, OutstandingReport, PaymentKind } from "../lib/types";

export function OutstandingPage({
  entries,
  revision,
  entriesLoading,
  onPayment,
}: {
  entries: Entry[];
  revision: number;
  entriesLoading: boolean;
  onPayment: (entry: Entry, kind: PaymentKind) => void;
}) {
  const [asOf, setAsOf] = useState(localDate),
    [draftDate, setDraftDate] = useState(localDate),
    [direction, setDirection] = useState("all"),
    [overdueOnly, setOverdueOnly] = useState(false),
    [query, setQuery] = useState(""),
    [report, setReport] = useState<OutstandingReport | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [dateError, setDateError] = useState(""),
    [reload, setReload] = useState(0);
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    request<OutstandingReport>(
      `/outstanding?as_of=${asOf}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (active) setReport(value);
      })
      .catch((issue) => {
        if (active) setError(errorMessage(issue));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [asOf, revision, reload]);
  const current = report?.as_of === asOf ? report : null;
  const normalized = query.trim().toLocaleLowerCase();
  const visible = (current?.items ?? []).filter((item) => {
    const entry = entryById.get(item.entry_id);
    return (
      (direction === "all" ||
        (direction === "receivable"
          ? item.kind === "receipt"
          : item.kind !== "receipt")) &&
      (!overdueOnly || item.status === "overdue") &&
      (!normalized ||
        `${item.description} ${item.category} ${item.counterparty} ${entry?.external_id ?? ""} ${entry?.note ?? ""}`
          .toLocaleLowerCase()
          .includes(normalized))
    );
  });
  const filtered = visible.reduce(
    (total, item) => {
      total[item.kind === "receipt" ? "receivable" : "payable"] +=
        item.outstanding_cents;
      return total;
    },
    { receivable: 0, payable: 0 },
  );
  return (
    <>
      <p className="page-note">
        按截止日列出仍未收、未付的业务。登记收付款时，以当前全部有效流水计算的余额为准。
      </p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validDate(draftDate)) {
            setDateError("请填写有效的欠款截止日期");
            return;
          }
          setDateError("");
          if (draftDate === asOf) setReload((value) => value + 1);
          else setAsOf(draftDate);
        }}
      >
        <Field
          label="欠款截止日期"
          type="date"
          required
          min="2000-01-01"
          max="2100-12-31"
          value={draftDate}
          onChange={(e) => setDraftDate(e.target.value)}
        />
        <button disabled={loading}>查看欠款</button>
        {current && !loading && !error ? (
          <a
            className="button"
            href={`/api/export/outstanding.csv?as_of=${asOf}`}
            download
          >
            导出此截止日全部欠款 CSV
          </a>
        ) : null}
      </form>
      <ErrorMessage message={dateError || error} />
      {error ? (
        <button
          onClick={() => setReload((value) => value + 1)}
          disabled={loading}
        >
          重新读取欠款
        </button>
      ) : null}
      {loading ? (
        <p role="status" className="muted">
          正在读取欠款…
        </p>
      ) : null}
      {current ? (
        <div aria-busy={loading}>
          <section className="panel" aria-label="截止日全部欠款合计">
            <h2>截至 {current.as_of} · 全部欠款</h2>
            <div className="outstanding-totals">
              <p>
                未收{" "}
                <strong className="money">
                  ¥{formatMoney(current.receivable_cents)}
                </strong>
                <span className="cell-subtext">
                  其中逾期 ¥{formatMoney(current.overdue_receivable_cents)}
                </span>
              </p>
              <p>
                未付{" "}
                <strong className="money">
                  ¥{formatMoney(current.payable_cents)}
                </strong>
                <span className="cell-subtext">
                  其中逾期 ¥{formatMoney(current.overdue_payable_cents)}
                </span>
              </p>
            </div>
            <p className="muted small">
              以上为此截止日的全部欠款，不受下方筛选影响；CSV
              也导出此截止日全部欠款。
            </p>
          </section>
          <div className="filters">
            <label className="field">
              收付方向
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="all">全部方向</option>
                <option value="receivable">未收款</option>
                <option value="payable">未付款</option>
              </select>
            </label>
            <Field
              label="检索欠款"
              type="search"
              placeholder="项目、往来、分类、导入编号或备注"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(e) => setOverdueOnly(e.target.checked)}
              />
              只看逾期
            </label>
          </div>
          <section className="panel">
            <div className="section-heading">
              <h2>欠款明细</h2>
              <span className="muted">{visible.length} 项</span>
            </div>
            <p className="small">
              筛选合计：未收{" "}
              <strong className="money">
                ¥{formatMoney(filtered.receivable)}
              </strong>{" "}
              · 未付{" "}
              <strong className="money">
                ¥{formatMoney(filtered.payable)}
              </strong>
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>项目 / 业务日期</th>
                    <th>往来</th>
                    <th>方向</th>
                    <th>到期日 / 状态</th>
                    <th className="numeric">原金额（元）</th>
                    <th className="numeric">截至当日已收付</th>
                    <th className="numeric">截至当日未收付</th>
                    <th>登记当前收付款</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => {
                    const entry = entryById.get(item.entry_id);
                    const remaining =
                      !entry || entry.voided_at
                        ? 0
                        : item.kind === "receipt"
                          ? entry.revenue_cents - entry.received_cents
                          : item.kind === "cost_payment"
                            ? entry.cost_cents - entry.paid_cents
                            : entry.amount_cents - entry.paid_cents;
                    return (
                      <tr key={`${item.entry_id}-${item.kind}`}>
                        <td className="description-cell">
                          {item.description}
                          <span className="cell-subtext">
                            {item.date} · {item.category}
                          </span>
                        </td>
                        <td className="note-cell">
                          {item.counterparty || "未填写往来"}
                        </td>
                        <td className="nowrap">{paymentLabels[item.kind]}</td>
                        <td className="nowrap">
                          {item.due_date || "未设到期日"}
                          <span
                            className={`cell-subtext ${item.status === "overdue" ? "negative" : ""}`}
                          >
                            {item.status === "overdue"
                              ? `逾期 ${item.overdue_days} 天`
                              : item.status === "due_today"
                                ? "当日到期"
                                : item.status === "upcoming"
                                  ? "未到期"
                                  : ""}
                          </span>
                        </td>
                        <td className="numeric money">
                          {formatMoney(item.original_cents)}
                        </td>
                        <td className="numeric money">
                          {formatMoney(item.settled_cents)}
                        </td>
                        <td className="numeric money">
                          {formatMoney(item.outstanding_cents)}
                        </td>
                        <td>
                          <button
                            disabled={
                              loading ||
                              entriesLoading ||
                              !!error ||
                              !entry ||
                              !!entry.voided_at ||
                              remaining <= 0
                            }
                            onClick={() => {
                              if (entry) onPayment(entry, item.kind);
                            }}
                          >
                            {item.kind === "receipt"
                              ? "登记收款"
                              : item.kind === "cost_payment"
                                ? "登记成本付款"
                                : "登记付款"}
                          </button>
                          <span className="cell-subtext">
                            {!entry || entry.voided_at
                              ? "当前单据已不可登记"
                              : remaining <= 0
                                ? "当前已结清，历史欠款仍保留"
                                : `当前可${item.kind === "receipt" ? "收" : "付"} ¥${formatMoney(remaining)}`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {visible.length === 0 ? (
              <p className="empty-state muted">没有符合条件的欠款</p>
            ) : null}
            <p className="muted small table-footnote">
              到期日早于截止日才算逾期；当天到期单列。历史欠款可能已在后来结清，右侧操作按当前全时间余额登记。
            </p>
          </section>
        </div>
      ) : null}
    </>
  );
}
