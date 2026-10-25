import { useState } from "react";
import { AlertTriangle, WandSparkles } from "lucide-react";
import { fmt, t } from "../../i18n";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const PRESETS = [t.rewrite.presetCasual, t.rewrite.presetShorter, t.rewrite.presetFormal, t.rewrite.presetExample, t.rewrite.presetSlower] as const;

/**
 * 「AI 重寫本頁」 asks for a direction first (VoAI/HeyGen let you steer a rewrite too) and says
 * what it costs: the page's finished paid avatar goes stale with the old text.
 */
export function RewriteDialog({
  open,
  page,
  userEdited,
  fresh = false,
  avatarCost,
  replansOutline = false,
  checking = false,
  onClose,
  onRewrite,
}: {
  open: boolean;
  page: number;
  userEdited: boolean;
  /** The page has no script yet: 「AI 產生」, nothing gets replaced. */
  fresh?: boolean;
  /** Set when this page has a finished paid avatar (e.g. 「約 NT$40」). */
  avatarCost?: string;
  /** The job plans a new outline first (settings or slides changed since): other pages may be affected. */
  replansOutline?: boolean;
  /** Still asking the server what the rewrite involves: the button waits so the note is never missed. */
  checking?: boolean;
  onClose: () => void;
  onRewrite: (instruction: string | undefined) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const instruction = [...picked, custom.trim()].filter(Boolean).join("；");

  const toggle = (p: string) => setPicked((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
  const submit = () => {
    onRewrite(instruction || undefined);
    setPicked([]);
    setCustom("");
  };

  return (
    <Modal
      title={fmt(fresh ? t.rewrite.titleFresh : t.rewrite.title, { n: page })}
      open={open}
      onClose={onClose}
      width="w-[460px]"
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" icon={WandSparkles} onClick={submit} disabled={checking} data-testid="rewrite-submit">
            {instruction ? t.rewrite.submit : t.rewrite.submitPlain}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <div>
          <p className="mb-2 text-xs text-neutral-400">{t.rewrite.pick}</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.rewrite.pick}>
            {PRESETS.map((p) => {
              const on = picked.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(p)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-accent-500 bg-accent-500/20 text-accent-100" : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"}`}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          {t.rewrite.custom}
          <textarea
            className="h-16 resize-none rounded-md border border-neutral-700 bg-neutral-950 p-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent-500 focus:outline-none"
            value={custom}
            maxLength={300}
            placeholder={t.rewrite.customPlaceholder}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <ul className="flex flex-col gap-1 text-xs text-neutral-400">
          {!fresh && <li>{t.rewrite.noteReplace}</li>}
          {userEdited && <li className="text-amber-200">{t.rewrite.noteUserEdited}</li>}
          {replansOutline && (
            <li className="flex gap-1.5 text-amber-200" data-testid="rewrite-replan">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t.rewrite.noteReplan}
            </li>
          )}
          {avatarCost && (
            <li className="flex gap-1.5 text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {fmt(t.script.editWarnAvatar, { cost: avatarCost })}
            </li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
