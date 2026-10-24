import { useEffect, useMemo, useRef, useState } from "react";
import { avatarInVideo } from "@lvs/shared";
import { Link } from "react-router";
import { ChevronDown, ChevronLeft, Clock, FileText, Settings, Upload } from "lucide-react";
import { ThemeToggle } from "../ThemeToggle";
import type { EditorActions } from "../../hooks/useEditorActions";
import { useCostEstimate, type CombinedEstimate } from "../../hooks/useCostEstimate";
import { ACCEPTED_EXTENSIONS } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { confirmReplaceSource } from "../../lib/replaceSource";
import { formatDuration, formatTwdFirst } from "../../lib/format";
import { estimateLines, twdShort } from "../../lib/paidJobs";
import { buildTimeline } from "../../lib/timelineModel";
import { useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Misc";
import { ExportMenu } from "./ExportMenu";
import { BatchMenu } from "./BatchMenu";
import { JobsIndicator } from "./JobsDrawer";

export interface EditorHeaderProps {
  actions: EditorActions;
  onOpenJobs: () => void;
}

export function EditorHeader({ actions, onOpenJobs }: EditorHeaderProps) {
  const detail = useEditor((s) => s.detail);
  const fileInput = useRef<HTMLInputElement>(null);

  // Changes whenever a scene's derived state or a script changes, which is what estimates depend on.
  const revision = useMemo(
    () =>
      detail
        ? detail.scenes
            .map((s) => `${s.id}:${s.script.status}:${s.audio.status}:${s.avatar.status}:${s.muted}:${detail.scripts[s.id]?.version ?? 0}`)
            .join("|") +
          `|${detail.project.settings.voice.providerId}:${detail.project.settings.avatar.providerId ?? ""}:${detail.slides.filter((sl) => sl.hidden).length}`
        : "",
    [detail],
  );
  const avatarEnabled = detail ? avatarInVideo(detail.project.settings.avatar) : false;
  // Like 下一步 and 補齊: only pages without a script count as work left (an outdated one is optional).
  const missingScripts = useMemo(
    () => (detail ? detail.scenes.filter((s) => !detail.slides.find((sl) => sl.id === s.slideId)?.hidden && (s.script.status === "missing" || s.script.status === "failed")).map((s) => s.id) : []),
    [detail],
  );
  const estimate = useCostEstimate(detail?.project.id, avatarEnabled, revision, missingScripts);

  if (!detail) return null;
  const { project, sourceDocument } = detail;
  const hasSlides = detail.slides.length > 0;
  // Same numbers as the timeline: estimated narration counts until the audio exists (then "約").
  const timeline = buildTimeline(detail.scenes, detail.slides, detail.scripts);
  const durationLabel = fmt(timeline.blocks.some((b) => b.estimated) ? t.editor.totalDurationEstimated : t.editor.totalDuration, {
    time: formatDuration(timeline.totalSec),
  });

  const pickFile = async () => {
    if (!(await confirmReplaceSource(detail))) return;
    fileInput.current?.click();
  };

  return (
    <header tabIndex={-1} data-editor-start aria-label={project.name} className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-3 outline-none">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Link
          to="/"
          aria-label={t.editor.projects}
          title={t.editor.projects}
          className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-xs whitespace-nowrap text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <ChevronLeft className="size-4" aria-hidden />
          <span className="hidden min-[1360px]:inline">{t.editor.projects}</span>
        </Link>
        <div className="h-6 w-px bg-neutral-800" />
        <div className="flex min-w-0 flex-col">
          <ProjectName name={project.name} onRename={(name) => void actions.updateProject({ name })} />
          <span className="flex items-center gap-1 truncate text-xs text-neutral-400">
            <FileText className="size-3" aria-hidden />
            {sourceDocument?.filename ?? t.editor.noSource}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          {/* Before the deck is parsed there is nothing to time or price (「全部最新」 would be wrong). */}
          {hasSlides && <span className="hidden min-[1200px]:contents">
            <Badge>
              <Clock className="size-3" aria-hidden />
              {durationLabel}
            </Badge>
          </span>}
          {hasSlides && estimate && <CostBadge estimate={estimate} />}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <JobsIndicator onOpen={onOpenJobs} />
        {sourceDocument ? (
          <BatchMenu actions={actions} onReplace={() => void pickFile()} />
        ) : (
          <Button icon={Upload} onClick={() => void pickFile()}>
            {t.editor.upload}
          </Button>
        )}
        <ExportMenu actions={actions} disabled={!hasSlides} />
        {/* Error help points here (「右上角『進階設定』」), so the editor offers it too. */}
        <Link
          to="/settings/providers"
          aria-label={t.app.navProviders}
          title={t.app.navProviders}
          className="flex size-8 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="editor-settings-link"
        >
          <Settings className="size-4" aria-hidden />
        </Link>
        <ThemeToggle compact />
      </div>

      <input
        ref={fileInput}
        type="file"
        hidden
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void actions.upload(file);
          e.target.value = "";
        }}
      />

    </header>
  );
}

function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== name) onRename(next);
    else setValue(name);
  };

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={t.projects.name}
        className="w-72 rounded border border-accent-500 bg-neutral-950 px-1.5 py-0.5 text-sm font-semibold text-neutral-100 focus:outline-none"
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title={t.editor.renameHint}
      className="max-w-36 truncate rounded px-1.5 py-0.5 text-left text-sm font-semibold text-neutral-100 hover:bg-neutral-800 min-[1360px]:max-w-72"
      onClick={() => {
        setValue(name);
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}

/**
 * 「做完剩下的頁面 約 NT$321」 as a button: the breakdown opens on click (not only on hover), and it
 * says how this total relates to the price on 下一步, which covers that one step only.
 */
function CostBadge({ estimate }: { estimate: CombinedEstimate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pending = Object.values(estimate.parts).filter(Boolean);
  if (pending.length === 0) return <Badge tone="success">{t.editor.estimateNone}</Badge>;
  const label = estimate.total > 0 ? fmt(t.editor.estimate, { cost: twdShort(estimate.total, estimate.currency) }) : t.editor.estimateFree;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-accent-500/30 bg-accent-500/15 px-2 py-0.5 text-xs text-accent-300 hover:bg-accent-500/25"
        data-testid="cost-badge"
      >
        {label}
        <ChevronDown className="size-3" aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label={t.editor.estimateTitle} className="absolute top-8 left-0 z-30 w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-xs text-neutral-300 shadow-2xl">
          <p className="mb-2 text-neutral-400">{t.editor.estimateTitle}</p>
          <ul className="mb-2 flex flex-col gap-1">
            {pending.flatMap((p) => estimateLines(p!)).map((line) => (
              <li key={line}>・{line}</li>
            ))}
          </ul>
          <p className="font-medium text-neutral-100">{fmt(t.paid.cost, { cost: formatTwdFirst(estimate.total, estimate.currency) })}</p>
          <p className="mt-2 text-neutral-400">{t.editor.estimateNote}</p>
        </div>
      )}
    </div>
  );
}
