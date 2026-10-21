import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AudioLines, ChevronLeft, Clock, FileText, NotebookPen, Upload, UserRound } from "lucide-react";
import type { EditorActions } from "../../hooks/useEditorActions";
import { useCostEstimate } from "../../hooks/useCostEstimate";
import { ACCEPTED_EXTENSIONS } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { toast } from "../../store/toastStore";
import { formatCost, formatDuration } from "../../lib/format";
import { useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Badge } from "../ui/Misc";
import { ExportMenu } from "./ExportMenu";
import { GenerateButton } from "./GenerateButton";
import { JobsIndicator } from "./JobsDrawer";

export interface EditorHeaderProps {
  actions: EditorActions;
  onOpenJobs: () => void;
}

export function EditorHeader({ actions, onOpenJobs }: EditorHeaderProps) {
  const detail = useEditor((s) => s.detail);
  const fileInput = useRef<HTMLInputElement>(null);
  const [avatarConfirm, setAvatarConfirm] = useState(false);

  // Changes whenever a scene's derived state or a script changes, which is what estimates depend on.
  const revision = useMemo(
    () =>
      detail
        ? detail.scenes
            .map((s) => `${s.id}:${s.audio.status}:${s.avatar.status}:${s.muted}:${detail.scripts[s.id]?.version ?? 0}`)
            .join("|")
        : "",
    [detail],
  );
  const avatarEnabled = detail?.project.settings.avatar.enabled ?? false;
  const estimate = useCostEstimate(detail?.project.id, avatarEnabled, revision);

  if (!detail) return null;
  const { project, sourceDocument } = detail;
  const hasSlides = detail.slides.length > 0;
  const busy = (type: string) => detail.activeJobs.some((j) => j.type === type);

  const pickFile = () => {
    if (sourceDocument && !window.confirm(t.upload.replaceConfirm)) return;
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
          <span className="flex items-center gap-1 truncate text-[11px] text-neutral-500">
            <FileText className="size-3" aria-hidden />
            {sourceDocument?.filename ?? t.editor.noSource}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          <Badge>
            <Clock className="size-3" aria-hidden />
            {fmt(t.editor.totalDuration, { time: formatDuration(detail.totalDurationSec) })}
          </Badge>
          {estimate && (
            <Badge tone="accent" title={t.editor.estimateTitle}>
              {fmt(t.editor.estimate, { cost: formatCost(estimate.total, estimate.currency) })}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <JobsIndicator onOpen={onOpenJobs} />
        <Button icon={Upload} onClick={pickFile}>
          {t.editor.upload}
        </Button>
        <GenerateButton kind="generate_script" icon={NotebookPen} label={t.editor.generateScripts} actions={actions} disabled={!hasSlides || busy("generate_script")} />
        <GenerateButton kind="synthesize_speech" icon={AudioLines} label={t.editor.generateSpeech} actions={actions} disabled={!hasSlides || busy("synthesize_speech")} />
        <Button
          icon={UserRound}
          disabled={!hasSlides || busy("generate_avatar")}
          title={avatarEnabled ? undefined : t.editor.avatarDisabled}
          onClick={() => (avatarEnabled ? setAvatarConfirm(true) : toast(t.editor.avatarDisabled, "info"))}
        >
          {t.editor.generateAvatar}
        </Button>
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

      <Modal
        open={avatarConfirm}
        onClose={() => setAvatarConfirm(false)}
        title={t.editor.avatarConfirmTitle}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAvatarConfirm(false)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="primary"
              data-autofocus
              onClick={() => {
                setAvatarConfirm(false);
                void actions.enqueue({ type: "generate_avatar", force: false });
              }}
            >
              {t.common.confirm}
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-300">{t.editor.avatarConfirmBody}</p>
        {estimate?.parts.generate_avatar && (
          <p className="mt-3 text-sm font-medium text-neutral-100">
            {fmt(t.editor.avatarConfirmCost, {
              cost: formatCost(estimate.parts.generate_avatar.total, estimate.parts.generate_avatar.currency),
            })}
          </p>
        )}
      </Modal>
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
      className="max-w-72 truncate rounded px-1.5 py-0.5 text-left text-sm font-semibold text-neutral-100 hover:bg-neutral-800"
      onClick={() => {
        setValue(name);
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}
