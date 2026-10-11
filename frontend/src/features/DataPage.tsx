import { useRef, useState } from "react";
import { ErrorMessage, Modal, useSubmit } from "../components/Forms";
import { errorMessage, request } from "../lib/api";
import { formatMoney, localDate, parseMoney, saleTotals } from "../lib/money";
import type { ImportPreview, Meta } from "../lib/types";
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取文件，请重新选择"));
    reader.readAsText(file, "UTF-8");
  });
}
export function DataPage({
  meta,
  onChanged,
}: {
  meta: Meta;
  onChanged: () => void;
}) {
  const [csv, setCsv] = useState(""),
    [fileName, setFileName] = useState(""),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [backup, setBackup] = useState<unknown>(null),
    [backupName, setBackupName] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState<"demo" | "restore" | null>(null),
    [reading, setReading] = useState(false);
  const { busy, error, setError, run } = useSubmit(),
    fileRevision = useRef(0),
    csvInput = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null);
  const empty = meta.entry_count === 0 && meta.payment_count === 0;
  const backupInfo =
    backup && typeof backup === "object"
      ? (backup as { entries?: unknown[]; payments?: unknown[] })
      : null;
  const disabled = busy || reading;
  async function chooseFile(file: File | undefined, kind: "csv" | "backup") {
    const revision = ++fileRevision.current;
    setError("");
    setNotice("");
    if (kind === "csv") {
      setCsv("");
      setPreview(null);
      setFileName("");
    } else {
      setBackup(null);
      setBackupName("");
    }
    if (!file) return;
    setReading(true);
    try {
      if (file.size > (kind === "csv" ? 2 : 128) * 1024 * 1024)
        throw new Error(
          `${kind === "csv" ? "CSV" : "JSON 备份"}文件不能超过 ${kind === "csv" ? "2" : "128"} MiB`,
        );
      const content = await readFile(file);
      if (revision !== fileRevision.current) return;
      if (kind === "csv") {
        setCsv(content);
        setFileName(file.name);
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new Error("JSON 格式不正确，请选择本工具导出的完整备份");
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !Array.isArray((parsed as { entries?: unknown }).entries) ||
          !Array.isArray((parsed as { payments?: unknown }).payments)
        )
          throw new Error("备份须包含 entries 和 payments 列表");
        setBackup(parsed);
        setBackupName(file.name);
      }
    } catch (error) {
      if (revision === fileRevision.current) setError(errorMessage(error));
    } finally {
      if (revision === fileRevision.current) setReading(false);
    }
  }
  return (
    <div className="data-page">
      <p className="page-note">
        业务 CSV 用于批量录入与查阅；完整 JSON 备份包含业务、流水和作废记录。
      </p>
      {!confirm ? <ErrorMessage message={error} /> : null}
      {notice ? (
        <div role="status" className="notice">
          {notice}
        </div>
      ) : null}
      <section className="panel">
        <div className="section-heading">
          <h2>导入销售与费用</h2>
          <a className="text-link" href="/api/import/template.csv" download>
            下载 CSV 模板
          </a>
        </div>
        <p className="muted">
          先按模板整理，再预检。每行必须有唯一的 external_id；最多 2,000 行、2
          MiB。流水不支持 CSV 导入。
        </p>
        <div className="file-actions">
          <label className="field">
            选择 CSV 文件
            <input
              ref={csvInput}
              type="file"
              accept=".csv,text/csv"
              disabled={disabled}
              onChange={(e) => void chooseFile(e.target.files?.[0], "csv")}
            />
          </label>
          <button
            disabled={disabled || !csv}
            onClick={() =>
              void run(async () => {
                setPreview(null);
                setNotice("");
                setPreview(
                  await request<ImportPreview>("/import/preview", {
                    csv_text: csv,
                  }),
                );
              })
            }
          >
            {busy ? "处理中…" : "预检文件"}
          </button>
        </div>
        {fileName ? <p className="muted small">已选择：{fileName}</p> : null}
        {reading ? <p role="status">正在读取文件…</p> : null}
        {preview ? (
          preview.errors.length ? (
            <div className="import-errors" role="alert">
              <h3>发现 {preview.errors.length} 项问题，未导入任何记录</h3>
              <ul>
                {preview.errors.map((item, index) => (
                  <li key={`${item.row}-${index}`}>
                    第 {item.row} 行：{item.message}
                  </li>
                ))}
              </ul>
              <p>请修改原文件，重新选择后预检。</p>
            </div>
          ) : (
            <div className="preview">
              <div className="section-heading">
                <h3>预检通过 · 共 {preview.count} 条记录</h3>
                <button
                  className="primary"
                  disabled={disabled || preview.count === 0}
                  onClick={() =>
                    void run(async () => {
                      const result = await request<{ imported: number }>(
                        "/import/commit",
                        { csv_text: csv },
                      );
                      setPreview(null);
                      setCsv("");
                      setFileName("");
                      if (csvInput.current) csvInput.current.value = "";
                      setNotice(
                        `已导入 ${result.imported} 条记录。收付款请另行登记。`,
                      );
                      onChanged();
                    })
                  }
                >
                  {busy ? "正在导入…" : `确认导入 ${preview.count} 条`}
                </button>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>项目</th>
                      <th>类型</th>
                      <th>分类</th>
                      <th className="numeric">金额</th>
                      <th className="numeric">直接成本</th>
                      <th>导入编号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 20).map((row, index) => (
                      <tr key={index}>
                        <td>{row.date}</td>
                        <td>{row.description}</td>
                        <td>{row.kind === "sale" ? "销售" : "费用"}</td>
                        <td>{row.category}</td>
                        <td className="money numeric">
                          ¥
                          {formatMoney(
                            row.kind === "sale"
                              ? saleTotals(
                                  String(row.quantity),
                                  row.unit_price ?? "0",
                                  row.unit_cost ?? "0",
                                ).revenue
                              : parseMoney(row.amount ?? "0"),
                          )}
                        </td>
                        <td className="money numeric">
                          {row.kind === "sale"
                            ? `¥${formatMoney(saleTotals(String(row.quantity), row.unit_price ?? "0", row.unit_cost ?? "0").cost)}`
                            : "—"}
                        </td>
                        <td>{row.external_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.count > 20 ? (
                <p className="muted small">
                  显示前 20 条，确认后将整批导入 {preview.count} 条。
                </p>
              ) : null}
              <p className="muted small">
                提交时会再次校验；若有任何错误，整批不会写入。
              </p>
            </div>
          )
        ) : null}
      </section>
      <div className="data-grid">
        <section className="panel">
          <h2>导出与备份</h2>
          <p className="muted">
            CSV 包含作废状态。业务 CSV 可重新预检；流水 CSV 仅供查阅。
          </p>
          <div className="download-list">
            <a className="button" href="/api/export/entries.csv" download>
              导出销售与费用 CSV
            </a>
            <a className="button" href="/api/export/payments.csv" download>
              导出收付款 CSV
            </a>
            <a
              className="button primary"
              href="/api/backup"
              download={`小本账_完整备份_${localDate()}.json`}
            >
              下载完整 JSON 备份
            </a>
          </div>
          <p className="muted small">
            备份包含全部账目，请妥善保管。建议定期下载，并保存在另一处。
          </p>
        </section>
        <section className="panel">
          <h2>恢复完整备份</h2>
          <p className="muted">
            只允许恢复到完全空的账本，包括没有作废记录。恢复会保留原编号、流水关联和作废原因。
          </p>
          {!empty ? (
            <p className="inline-note">当前账本已有记录，不能恢复备份。</p>
          ) : null}
          <label className="field">
            选择 JSON 备份
            <input
              ref={backupInput}
              type="file"
              accept=".json,application/json"
              disabled={!empty || disabled}
              onChange={(e) => void chooseFile(e.target.files?.[0], "backup")}
            />
          </label>
          {backup ? (
            <>
              <p className="muted small">
                {backupName} · {backupInfo?.entries?.length ?? 0} 条业务 /{" "}
                {backupInfo?.payments?.length ?? 0} 条流水
              </p>
              <button
                disabled={!empty || disabled}
                onClick={() => setConfirm("restore")}
              >
                检查并恢复备份
              </button>
            </>
          ) : null}
        </section>
      </div>
      <section className="panel demo-panel">
        <div>
          <h2>示例账本</h2>
          <p className="muted">
            在空账本中载入一组虚构记录，体验销售、费用和分次收付款。载入后会明确标为示例账本。
          </p>
          {!empty ? (
            <p className="small muted">
              当前已有 {meta.entry_count} 条业务、{meta.payment_count}{" "}
              条流水（含作废），不能载入示例。
            </p>
          ) : null}
        </div>
        <button
          disabled={!empty || disabled}
          onClick={() => setConfirm("demo")}
        >
          载入示例账本
        </button>
      </section>
      {confirm ? (
        <Modal
          title={confirm === "demo" ? "载入虚构示例" : "确认恢复备份"}
          busy={busy}
          onClose={() => setConfirm(null)}
        >
          <p>
            {confirm === "demo"
              ? "将向当前空账本添加虚构销售、费用和收付款，并永久标记为示例账本。"
              : "将完整恢复选中的 JSON 备份。服务器会校验金额、日期和关联，任何错误都不会写入。"}
          </p>
          {confirm === "restore" ? (
            <p className="muted">文件：{backupName}</p>
          ) : null}
          <ErrorMessage message={error} />
          <div className="dialog-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (confirm === "demo") {
                    await request("/demo", {});
                    setNotice("已载入示例账本，以下均为虚构数据。");
                  } else {
                    const result = await request<{
                      restored_entries: number;
                      restored_payments: number;
                    }>("/restore", { backup });
                    setNotice(
                      `已恢复 ${result.restored_entries} 条业务和 ${result.restored_payments} 条流水。`,
                    );
                    setBackup(null);
                    setBackupName("");
                    if (backupInput.current) backupInput.current.value = "";
                  }
                  setConfirm(null);
                  onChanged();
                })
              }
            >
              {busy
                ? "正在处理…"
                : confirm === "demo"
                  ? "确认载入示例"
                  : "确认恢复"}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
