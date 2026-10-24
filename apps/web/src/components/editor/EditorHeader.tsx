import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, Clock, FileText, Upload } from "lucide-react";
import type { EditorActions } from "../../hooks/useEditorActions";
import { useCostEstimate } from "../../hooks/useCostEstimate";
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
  const avatarEnabled = detail?.project.settings.avatar.enabled ?? false;
  const estimate = useCostEstimate(detail?.project.id, avatarEnabled, revision);

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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-3">
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
          <span className="flex items-center gap-1 truncate text-xs text-neutral-500">
            <FileText className="size-3" aria-hidden />
            {sourceDocument?.filename ?? t.editor.noSource}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          <span className="hidden min-[1200px]:contents">
            <Badge>
              <Clock className="size-3" aria-hidden />
              {durationLabel}
            </Badge>
          </span>
          {estimate && (
            <Badge
              tone="accent"
              title={[
                t.editor.estimateTitle,
                ...Object.values(estimate.parts).flatMap((p) => (p ? estimateLines(p) : [])),
                fmt(t.paid.cost, { cost: formatTwdFirst(estimate.total, estimate.currency) }),
              ].join("\n")}
            >
              {estimate.total > 0 ? fmt(t.editor.estimate, { cost: twdShort(estimate.total, estimate.currency) }) : t.editor.estimateNone}
            </Badge>
          )}
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
