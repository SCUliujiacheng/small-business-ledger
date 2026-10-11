import { useEffect, useState } from "react";
import { ErrorMessage, useSubmit } from "../components/Forms";
import { errorMessage, request } from "../lib/api";
import type { LocalBackup, LocalBackups } from "../lib/types";

function displayTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function LocalBackupsPanel({ revision }: { revision: string }) {
  const [backups, setBackups] = useState<LocalBackups | null>(null),
    [loadError, setLoadError] = useState(""),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0),
    [notice, setNotice] = useState("");
  const { busy, error, run } = useSubmit();
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setLoadError("");
    request<LocalBackups>("/local-backups", undefined, controller.signal)
      .then((value) => {
        if (active) setBackups(value);
      })
      .catch((issue) => {
        if (active) setLoadError(errorMessage(issue));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [revision, reload]);
  return (
    <section className="panel" aria-label="本机自动备份">
      <div className="section-heading">
        <h2>本机自动备份</h2>
        <div className="row-actions">
          <button
            disabled={busy || loading}
            onClick={() => setReload((value) => value + 1)}
          >
            刷新备份列表
          </button>
          <button
            disabled={busy || loading}
            onClick={() =>
              void run(async () => {
                setNotice("");
                const item = await request<LocalBackup>("/local-backups", {});
                setNotice(`已保存当前快照：${item.filename}`);
                setReload((value) => value + 1);
              })
            }
          >
            {busy ? "正在生成…" : "生成当前快照"}
          </button>
        </div>
      </div>
      <p className="muted">
        每次改变非空账本前保存一份快照，通常比当前账本少最后一笔变化。空账本首次写入不生成自动备份。
      </p>
      <p className="muted small">
        同一硬盘上的备份不能防硬盘损坏，文件未加密。请另下载当前完整 JSON
        备份，存到其他位置；此列表仅供下载，恢复仍只能在空账本进行。
      </p>
      <ErrorMessage message={error || loadError} />
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      {loading ? (
        <p className="muted" role="status">
          正在读取备份列表…
        </p>
      ) : null}
      {backups ? (
        <>
          <dl className="record-details">
            <div className="full">
              <dt>备份目录</dt>
              <dd>{backups.directory}</dd>
            </div>
            <div>
              <dt>保留范围</dt>
              <dd>保留最近 {backups.retention} 份工具生成的本机备份</dd>
            </div>
            <div>
              <dt>最近备份（本地时间）</dt>
              <dd>
                {backups.items[0]
                  ? displayTime(backups.items[0].created_at)
                  : "尚无本机备份"}
              </dd>
            </div>
          </dl>
          {backups.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>时间（本地）</th>
                    <th>文件 / 下载</th>
                    <th className="numeric">大小</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.items.map((item) => (
                    <tr key={item.filename}>
                      <td className="nowrap">{displayTime(item.created_at)}</td>
                      <td className="backup-filename">
                        <a
                          className="text-link"
                          href={`/api/local-backups/${encodeURIComponent(item.filename)}`}
                          download
                        >
                          {item.filename}
                        </a>
                      </td>
                      <td className="numeric nowrap">
                        {(item.size_bytes / 1024).toLocaleString("zh-CN", {
                          maximumFractionDigits: 1,
                        })}{" "}
                        KiB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">
              尚无本机快照，可点击「生成当前快照」保存此刻的账本。
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
