import { useEffect, useRef, useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import type { Scene } from "@lvs/shared";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { useEditor } from "../../store/editorStore";
import { toast } from "../../store/toastStore";
import { Button } from "../ui/Button";

type Kind = "generate_script" | "synthesize_speech";

const STATE_OF: Record<Kind, (s: Scene) => Scene["script"]> = {
  generate_script: (s) => s.script,
  synthesize_speech: (s) => s.audio,
};

/**
 * "Generate all" split button: the main click fills in pages whose asset is missing, stale or
 * failed; the dropdown offers a forced regeneration of every page. Per-page actions live in
 * the script panel. When nothing needs work the user gets a hint instead of a silent no-op.
 */
export function GenerateButton({
  kind,
  icon,
  label,
  shortLabel,
  actions,
  disabled,
}: {
  kind: Kind;
  icon: LucideIcon;
  label: string;
  /** Shown instead of `label` on narrow screens (one word, e.g. 講稿). */
  shortLabel?: string;
  actions: Pick<EditorActions, "enqueue">;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const scenes = useEditor((s) => s.detail?.scenes ?? []);
  const slides = useEditor((s) => s.detail?.slides ?? []);
  const hiddenSlideIds = new Set(slides.filter((sl) => sl.hidden).map((sl) => sl.id));
  const visible = scenes.filter((sc) => !hiddenSlideIds.has(sc.slideId) && (kind === "generate_script" || !sc.muted));
  const pending = visible.filter((sc) => {
    const st = STATE_OF[kind](sc).status;
    return st === "missing" || st === "stale" || st === "failed";
  }).length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (force: boolean) => {
    setOpen(false);
    if (!force && pending === 0) {
      toast(fmt(t.generate.nothingToDo, { label }), "info");
      return;
    }
    void actions.enqueue({ type: kind, force });
  };

  return (
    <div ref={ref} className="relative flex items-stretch">
      <Button
        icon={icon}
        disabled={disabled}
        className="rounded-r-none"
        onClick={() => run(false)}
        aria-label={label}
        title={`${label}：${fmt(t.generate.pendingTitle, { count: pending, total: visible.length })}`}
      >
        <span className="min-[1360px]:hidden">{shortLabel ?? label}</span>
        <span className="hidden min-[1360px]:inline">{label}</span>
        {pending > 0 && <span className="ml-1 rounded bg-neutral-700 px-1 text-[10px] leading-4 text-neutral-200">{pending}</span>}
      </Button>
      <Button
        disabled={disabled}
        className="rounded-l-none border-l border-l-neutral-700 px-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.generate.moreOptions}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown className="size-3.5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-30 mt-1 w-72 rounded-md border border-neutral-800 bg-neutral-900 p-1 text-sm shadow-xl">
          <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-neutral-800" onClick={() => run(false)}>
            <div className="font-medium">{t.generate.fillMissing}</div>
            <div className="text-xs text-neutral-400">{fmt(t.generate.fillMissingHint, { count: pending })}</div>
          </button>
          <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-neutral-800" onClick={() => run(true)}>
            <div className="font-medium">{t.generate.regenerateAll}</div>
            <div className="text-xs text-neutral-400">{fmt(t.generate.regenerateAllHint, { count: visible.length })}</div>
          </button>
          <div className="border-t border-neutral-800 px-3 py-2 text-xs text-neutral-500">{t.generate.perPageHint}</div>
        </div>
      )}
    </div>
  );
}
