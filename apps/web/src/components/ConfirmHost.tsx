import { t } from "../i18n";
import { useConfirm } from "../store/confirmStore";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

/**
 * Renders the pending confirmation. Focus starts on 取消 so an accidental Enter never starts a
 * paid job.
 */
export function ConfirmHost() {
  const request = useConfirm((s) => s.request);
  const answer = useConfirm((s) => s.answer);
  return (
    <Modal
      open={request !== null}
      onClose={() => answer(false)}
      title={request?.title ?? ""}
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={() => answer(false)}>
            {t.common.cancel}
          </Button>
          <Button variant={request?.danger ? "danger" : "primary"} onClick={() => answer(true)} data-testid="confirm-ok">
            {request?.confirmLabel ?? t.common.confirm}
          </Button>
        </>
      }
    >
      {request && (
        <div className="flex flex-col gap-2 text-sm">
          <ul className="flex flex-col gap-1 text-neutral-100">
            {request.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {request.note && <p className="text-xs leading-relaxed text-neutral-400">{request.note}</p>}
        </div>
      )}
    </Modal>
  );
}
