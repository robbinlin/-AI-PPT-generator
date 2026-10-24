import { useEffect, useRef, useState } from "react";
import { ChevronDown, Layers, Upload } from "lucide-react";
import type { CostEstimate, Scene } from "@lvs/shared";
import type { EditorActions } from "../../hooks/useEditorActions";
import { usePendingEstimate } from "../../hooks/usePendingEstimate";
import { fmt, t } from "../../i18n";
import { twdShort } from "../../lib/paidJobs";
import { visibleScenes } from "../../lib/settingsImpact";
import { useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";

type Kind = "generate_script" | "synthesize_speech" | "generate_avatar";

const FIELD: Record<Kind, "script" | "audio" | "avatar"> = {
  generate_script: "script",
  synthesize_speech: "audio",
  generate_avatar: "avatar",
};

const pendingOf = (list: Scene[], kind: Kind) =>
  list.filter((s) => {
    const st = s[FIELD[kind]].status;
    return st === "missing" || st === "stale" || st === "failed";
  }).length;

/**
 * Whole-deck tools in one menu: the step bar is the guided path, so the header no longer repeats
 * 講稿／語音／人像 as separate buttons (they looked like the right panel's tabs but spend money).
 */
export function BatchMenu({ actions, onReplace }: { actions: Pick<EditorActions, "enqueue">; onReplace: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const detail = useEditor((s) => s.detail);
  // Prices of the 補齊 items, fetched while the menu is open (like the 下一步 button's).
  const pid = open ? detail?.project.id : undefined;
  const cost: Partial<Record<Kind, CostEstimate | undefined>> = {
    generate_script: usePendingEstimate(pid, "generate_script"),
    synthesize_speech: usePendingEstimate(pid, "synthesize_speech"),
    generate_avatar: usePendingEstimate(pid, "generate_avatar"),
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!detail) return null;
  const all = visibleScenes(detail);
  const spoken = all.filter((s) => !s.muted);
  const avatarOn = detail.project.settings.avatar.enabled && !!detail.project.settings.avatar.avatarId;
  const busy = (type: Kind) => detail.activeJobs.some((j) => j.type === type);
  const hasSlides = detail.slides.length > 0;

  const run = (kind: Kind, force: boolean) => {
    setOpen(false);
    void actions.enqueue({ type: kind, force });
  };

  const rows: Array<{ kind: Kind; label: string; list: Scene[]; redo: boolean; off?: string }> = [
    { kind: "generate_script", label: t.batch.script, list: all, redo: true },
    { kind: "synthesize_speech", label: t.batch.speech, list: spoken, redo: true },
    { kind: "generate_avatar", label: t.batch.avatar, list: spoken, redo: false, off: avatarOn ? undefined : t.batch.avatarOff },
  ];
  const item = "block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div ref={ref} className="relative">
      <Button icon={Layers} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="batch-menu">
        <span className="hidden min-[1200px]:inline">{t.batch.button}</span>
        <ChevronDown className="size-3.5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" aria-label={t.batch.title} className="absolute top-10 right-0 z-30 w-72 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-2xl">
          <p className="px-2 pb-1 text-xs text-neutral-400">{t.batch.title}</p>
          {rows.map((r) => {
            const pending = pendingOf(r.list, r.kind);
            const disabled = !hasSlides || busy(r.kind) || !!r.off;
            return (
              <div key={r.kind} className="border-t border-neutral-800 py-1">
                <div className="px-2 pt-1 text-xs font-medium text-neutral-300">{r.label}</div>
                {r.off ? (
                  <p className="px-2 py-1 text-xs text-neutral-400">{r.off}</p>
                ) : (
                  <>
                    <button type="button" role="menuitem" className={item} disabled={disabled || pending === 0} onClick={() => run(r.kind, false)}>
                      {pending > 0 ? fmt(t.batch.fill, { n: pending }) : t.batch.fillNone}
                      {pending > 0 && cost[r.kind] && <span className="ml-1 text-xs text-neutral-400">（{twdShort(cost[r.kind]!.total, cost[r.kind]!.currency)}）</span>}
                    </button>
                    {r.redo && (
                      <button type="button" role="menuitem" className={`${item} text-neutral-400`} disabled={disabled || r.list.length === 0} onClick={() => run(r.kind, true)}>
                        {fmt(t.batch.redoAll, { n: r.list.length })}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
          <div className="border-t border-neutral-800 pt-1">
            <button
              type="button"
              role="menuitem"
              className={`${item} flex items-center gap-2`}
              onClick={() => {
                setOpen(false);
                onReplace();
              }}
            >
              <Upload className="size-4" aria-hidden />
              {detail.sourceDocument ? t.batch.replace : t.batch.upload}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
