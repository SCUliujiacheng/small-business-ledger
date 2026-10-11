import { useState } from "react";
import { Modal } from "../components/Forms";
import type { Entry, PaymentKind } from "../lib/types";
import { PaymentForm } from "./PaymentForm";
export function PaymentDialog({
  entries,
  entryId,
  kind,
  onClose,
  onSaved,
}: {
  entries: Entry[];
  entryId: string;
  kind: PaymentKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="登记收付款" onClose={onClose} busy={busy}>
      <PaymentForm
        entries={entries}
        initialEntryId={entryId}
        initialKind={kind}
        onSaved={onSaved}
        onBusyChange={setBusy}
      />
    </Modal>
  );
}
