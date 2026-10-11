import { formatMoney } from "../lib/money";
import type { Entry, Summary } from "../lib/types";
export function Overview({
  summary,
  entries,
  isEmpty,
  onShowEntries,
  onNewEntry,
  onShowData,
}: {
  summary: Summary;
  entries: Entry[];
  isEmpty: boolean;
  onShowEntries: () => void;
  onNewEntry: () => void;
  onShowData: () => void;
}) {
  const recent = entries
    .filter(
      (entry) =>
        !entry.voided_at &&
        entry.date >= summary.start &&
        entry.date <= summary.end,
    )
    .slice(0, 6);
  const metrics = [
    ["销售额", summary.revenue_cents, "客户购买商品或服务的总金额"],
    ["直接成本", summary.cost_cents, "与当期销售直接相关的成本"],
    ["日常费用", summary.expense_cents, "房租、水电、人工等经营费用"],
    ["经营结余", summary.profit_cents, "扣除成本和费用后的经营结果"],
  ] as const;
  return (
    <>
      {isEmpty ? (
        <div className="empty-intro">
          <div>
            <strong>从第一笔开始</strong>
            <p>还没有记录，可以记第一笔，也可以载入示例账本。</p>
          </div>
          <div className="row-actions">
            <button onClick={onNewEntry}>记第一笔</button>
            <button className="link-button" onClick={onShowData}>
              前往示例账本
            </button>
          </div>
        </div>
      ) : null}
      <div className="metrics" aria-label="本期经营金额">
        {metrics.map(([label, value, description], index) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong
              className={`money ${index === 3 ? "accent" : ""} ${value < 0 ? "negative" : ""}`}
            >
              ¥{formatMoney(value)}
            </strong>
            <span className="muted small">{description}</span>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <h2>利润怎么算</h2>
          <table className="calculation-table">
            <thead>
              <tr>
                <th>项目</th>
                <th className="numeric">金额（元）</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>销售额</td>
                <td className="money numeric">
                  {formatMoney(summary.revenue_cents)}
                </td>
              </tr>
              <tr>
                <td>减：直接成本</td>
                <td className="money numeric">
                  {formatMoney(summary.cost_cents)}
                </td>
              </tr>
              <tr>
                <td>毛利</td>
                <td className="money numeric">
                  {formatMoney(summary.gross_profit_cents)}
                </td>
              </tr>
              <tr>
                <td>减：日常费用</td>
                <td className="money numeric">
                  {formatMoney(summary.expense_cents)}
                </td>
              </tr>
              <tr className="total-row">
                <td>经营结余</td>
                <td
                  className={`money numeric ${summary.profit_cents < 0 ? "negative" : ""}`}
                >
                  {formatMoney(summary.profit_cents)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small table-footnote">
            按业务发生日期计算；经营结余未计算税费、折旧，不作为报税凭证。
          </p>
        </section>
        <section className="panel cash-panel">
          <h2>收付款</h2>
          <table>
            <thead>
              <tr>
                <th>项目</th>
                <th className="numeric">金额（元）</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>本期收入</td>
                <td className="money numeric">
                  {formatMoney(summary.cash_in_cents)}
                </td>
              </tr>
              <tr>
                <td>本期支出</td>
                <td className="money numeric">
                  {formatMoney(summary.cash_out_cents)}
                </td>
              </tr>
              <tr className="total-row">
                <td>本期净流入</td>
                <td
                  className={`money numeric ${summary.net_cash_cents < 0 ? "negative" : ""}`}
                >
                  {formatMoney(summary.net_cash_cents)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="as-of muted small">截至 {summary.end}（累计）</p>
          <table aria-label="截至截止日的累计余额">
            <tbody>
              <tr>
                <td>未收款</td>
                <td className="money numeric">
                  {formatMoney(summary.receivable_cents)}
                </td>
              </tr>
              <tr>
                <td>未付款</td>
                <td className="money numeric">
                  {formatMoney(summary.payable_cents)}
                </td>
              </tr>
              <tr>
                <td>账面资金</td>
                <td className="money numeric">
                  {formatMoney(summary.balance_cents)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small table-footnote">
            收支按实际收付日期。账面资金以已记流水为准，不等于银行余额；资金投入、取出不计入经营结余。
          </p>
        </section>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>最近记录</h2>
          <button className="link-button" onClick={onShowEntries}>
            查看全部
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>项目</th>
                <th>类型</th>
                <th className="numeric">金额（元）</th>
                <th>累计收付情况</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((entry) => (
                <tr key={entry.id}>
                  <td className="nowrap">{entry.date}</td>
                  <td className="description-cell">{entry.description}</td>
                  <td>{entry.kind === "sale" ? "销售" : "费用"}</td>
                  <td className="money numeric">
                    {formatMoney(entry.amount_cents)}
                  </td>
                  <td className="small">
                    {entry.kind === "sale" ? (
                      <>
                        <span
                          className={
                            entry.received_cents >= entry.revenue_cents
                              ? "accent"
                              : ""
                          }
                        >
                          {entry.received_cents >= entry.revenue_cents
                            ? "已收款"
                            : entry.received_cents > 0
                              ? "部分收款"
                              : "未收款"}
                        </span>
                        <span className="muted">
                          {" "}
                          ·{" "}
                          {entry.paid_cents >= entry.cost_cents
                            ? "成本已付"
                            : "成本未付清"}
                        </span>
                      </>
                    ) : (
                      <span
                        className={
                          entry.paid_cents >= entry.amount_cents ? "accent" : ""
                        }
                      >
                        {entry.paid_cents >= entry.amount_cents
                          ? "已付款"
                          : entry.paid_cents > 0
                            ? "部分付款"
                            : "未付款"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recent.length === 0 ? (
          <p className="empty-state muted">所选日期内暂无业务记录。</p>
        ) : null}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>按月汇总</h2>
          <span className="muted small">仅统计所选日期范围内的记录</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>月份</th>
                <th className="numeric">销售额</th>
                <th className="numeric">直接成本</th>
                <th className="numeric">日常费用</th>
                <th className="numeric">经营结余</th>
                <th className="numeric">收入</th>
                <th className="numeric">支出</th>
              </tr>
            </thead>
            <tbody>
              {summary.monthly.map((month) => (
                <tr key={month.month}>
                  <td>{month.month}</td>
                  {(
                    [
                      "revenue_cents",
                      "cost_cents",
                      "expense_cents",
                      "profit_cents",
                      "cash_in_cents",
                      "cash_out_cents",
                    ] as const
                  ).map((field) => (
                    <td
                      key={field}
                      className={`money numeric ${field === "profit_cents" ? "accent" : ""}`}
                    >
                      {formatMoney(month[field])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
