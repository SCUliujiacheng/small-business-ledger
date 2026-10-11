import { useState } from "react";
import { ErrorMessage, Modal, useSubmit } from "../components/Forms";
import { request } from "../lib/api";
export interface VoidTarget {
  resource: "entries" | "payments";
  id: string;
  description: string;
}
export function VoidDialog({
  target,
  onClose,
  onSaved,
}: {
  target: VoidTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <Modal
      title={target.resource === "entries" ? "作废业务记录" : "作废收付款流水"}
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (!reason.trim()) throw new Error("请填写作废原因");
            await request(
              `/${target.resource}/${encodeURIComponent(target.id)}/void`,
              { reason: reason.trim() },
            );
            onSaved();
          });
        }}
      >
        <p>即将作废「{target.description}」。原记录会保留，报表将重新计算。</p>
        <p className="muted">
          作废用于更正录入错误，不代表退款。
          {target.resource === "entries"
            ? "若存在有效关联流水，请先在收付款页作废流水。"
            : ""}
        </p>
        <label className="field">
          作废原因
          <textarea
            required
            autoFocus
            maxLength={500}
            rows={3}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <ErrorMessage message={error} />
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="danger" disabled={busy}>
            {busy ? "正在作废…" : "确认作废"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
