import { useEffect, useState } from "react";
import { ErrorMessage } from "./components/Forms";
import { request, errorMessage } from "./lib/api";
import { currentMonth, validateRange } from "./lib/money";
import type { Entry, Meta, Payment, PaymentKind, Summary } from "./lib/types";
import { EntryDialog } from "./features/EntryDialog";
import { EntriesPage } from "./features/EntriesPage";
import { Overview } from "./features/Overview";
import { PaymentsPage } from "./features/PaymentsPage";
import { PaymentDialog } from "./features/PaymentDialog";
import { DataPage } from "./features/DataPage";
import { OutstandingPage } from "./features/OutstandingPage";
import { VoidDialog } from "./features/VoidDialog";
import type { VoidTarget } from "./features/VoidDialog";
const pages = [
  ["overview", "经营概览"],
  ["entries", "销售与费用"],
  ["outstanding", "欠款清单"],
  ["payments", "收付款"],
  ["data", "导入与备份"],
] as const;
type Page = (typeof pages)[number][0];
interface LedgerData {
  entries: Entry[];
  payments: Payment[];
  meta: Meta;
  summary: Summary;
}
export default function App() {
  const [page, setPage] = useState<Page>("overview"),
    [range, setRange] = useState(currentMonth),
    [draftRange, setDraftRange] = useState(currentMonth),
    [rangeError, setRangeError] = useState(""),
    [revision, setRevision] = useState(0),
    [data, setData] = useState<LedgerData | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [entryOpen, setEntryOpen] = useState(false),
    [paymentTarget, setPaymentTarget] = useState<{
      entryId: string;
      kind: PaymentKind;
    } | null>(null),
    [voidTarget, setVoidTarget] = useState<VoidTarget | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      request<{ items: Entry[] }>("/entries", undefined, controller.signal),
      request<{ items: Payment[] }>("/payments", undefined, controller.signal),
      request<Meta>("/meta", undefined, controller.signal),
      request<Summary>(
        `/summary?start=${range.start}&end=${range.end}`,
        undefined,
        controller.signal,
      ),
    ])
      .then(([entries, payments, meta, summary]) => {
        if (active)
          setData({
            entries: entries.items,
            payments: payments.items,
            meta,
            summary,
          });
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [range.start, range.end, revision]);
  function refresh() {
    setRevision((value) => value + 1);
  }
  function navigate(value: Page) {
    setPage(value);
    setNotice("");
  }
  function saved(message: string) {
    setNotice(message);
    refresh();
  }
  const title = pages.find(([id]) => id === page)?.[1] ?? "小本账";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">小本账</div>
        <nav aria-label="主要导航">
          {pages.map(([id, label]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>本机账本</span>
          <span>人民币 · CNY</span>
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        <div className="content">
          <header className="page-header">
            <div>
              <h1>{title}</h1>
              {page === "overview" ? (
                <p className="subtitle">先看利润，再看收付款。</p>
              ) : null}
              {data?.meta.demo ? (
                <p className="demo-label">示例账本 · 以下为虚构数据</p>
              ) : null}
            </div>
            <div className="header-actions">
              {page === "overview" ? (
                <form
                  className="range-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const issue = validateRange(
                      draftRange.start,
                      draftRange.end,
                    );
                    setRangeError(issue);
                    if (!issue) setRange({ ...draftRange });
                  }}
                >
                  <input
                    aria-label="概览开始日期"
                    type="date"
                    required
                    min="2000-01-01"
                    max="2100-12-31"
                    value={draftRange.start}
                    onChange={(e) =>
                      setDraftRange({ ...draftRange, start: e.target.value })
                    }
                  />
                  <span className="muted">至</span>
                  <input
                    aria-label="概览截止日期"
                    type="date"
                    required
                    min="2000-01-01"
                    max="2100-12-31"
                    value={draftRange.end}
                    onChange={(e) =>
                      setDraftRange({ ...draftRange, end: e.target.value })
                    }
                  />
                  <button disabled={loading}>查看</button>
                </form>
              ) : null}
              <button
                className="primary new-entry"
                disabled={!data || loading}
                onClick={() => setEntryOpen(true)}
              >
                记一笔
              </button>
            </div>
          </header>
          {page === "overview" ? (
            <>
              <ErrorMessage message={rangeError} />
              <p className="range-caption muted small">
                报表期间：{range.start} 至 {range.end}，含起止日
              </p>
            </>
          ) : null}
          {notice ? (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                className="dismiss-button"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          ) : null}
          <ErrorMessage message={error} />
          {error ? (
            <button onClick={refresh} disabled={loading}>
              重新加载
            </button>
          ) : null}
          {loading ? (
            <p className="loading-line muted" role="status">
              正在读取账本…
            </p>
          ) : null}
          {data ? (
            <div aria-busy={loading} className="page-body">
              {page === "overview" ? (
                data.summary.start === range.start &&
                data.summary.end === range.end ? (
                  <Overview
                    summary={data.summary}
                    entries={data.entries}
                    isEmpty={
                      data.meta.entry_count === 0 &&
                      data.meta.payment_count === 0
                    }
                    onShowEntries={() => navigate("entries")}
                    onNewEntry={() => setEntryOpen(true)}
                    onShowData={() => navigate("data")}
                  />
                ) : null
              ) : page === "entries" ? (
                <EntriesPage
                  entries={data.entries}
                  onPayment={(entry, kind) =>
                    setPaymentTarget({ entryId: entry.id, kind })
                  }
                  onVoid={setVoidTarget}
                />
              ) : page === "outstanding" ? (
                <OutstandingPage
                  entries={data.entries}
                  revision={revision}
                  entriesLoading={loading || !!error}
                  onPayment={(entry, kind) =>
                    setPaymentTarget({ entryId: entry.id, kind })
                  }
                />
              ) : page === "payments" ? (
                <PaymentsPage
                  entries={data.entries}
                  payments={data.payments}
                  onSaved={() =>
                    saved("已保存流水。经营概览与关联单据余额已更新。")
                  }
                  onVoid={setVoidTarget}
                />
              ) : (
                <DataPage meta={data.meta} onChanged={refresh} />
              )}
            </div>
          ) : null}
          <footer className="main-footer">
            小本账 · 本机单用户记账工具。数据保存在本机，请定期备份。
          </footer>
        </div>
      </main>
      {entryOpen ? (
        <EntryDialog
          onClose={() => setEntryOpen(false)}
          onSaved={() => {
            setEntryOpen(false);
            saved("已保存业务记录。请到「收付款」登记实际收款或付款。");
          }}
        />
      ) : null}
      {paymentTarget && data ? (
        <PaymentDialog
          key={`${paymentTarget.entryId}-${paymentTarget.kind}`}
          entries={data.entries}
          entryId={paymentTarget.entryId}
          kind={paymentTarget.kind}
          onClose={() => setPaymentTarget(null)}
          onSaved={() => {
            setPaymentTarget(null);
            saved("已保存收付款流水。");
          }}
        />
      ) : null}
      {voidTarget ? (
        <VoidDialog
          target={voidTarget}
          onClose={() => setVoidTarget(null)}
          onSaved={() => {
            setVoidTarget(null);
            saved("已作废记录，历史报表将按当前有效记录重新计算。");
          }}
        />
      ) : null}
    </div>
  );
}
