import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Film, Subtitles } from "lucide-react";
import { useApi, useAssetUrl } from "../../api/context";
import { errorMessage } from "../../api/types";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { downloadFile, formatBytes, formatRelativeTime } from "../../lib/format";
import { latestProjectAsset } from "../../lib/scenes";
import { useEditor } from "../../store/editorStore";
import { toast } from "../../store/toastStore";
import { Button } from "../ui/Button";

type Preset = "preview_540p" | "hd_1080p";

export function ExportMenu({ actions, disabled }: { actions: Pick<EditorActions, "enqueue">; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={ref} className="relative">
      <Button
        variant="primary"
        icon={Film}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {t.editor.export}
      </Button>
      {open && <ExportPanel actions={actions} onDone={() => setOpen(false)} />}
    </div>
  );
}

function ExportPanel({ actions, onDone }: { actions: Pick<EditorActions, "enqueue">; onDone: () => void }) {
  const api = useApi();
  const detail = useEditor((s) => s.detail);
  const [preset, setPreset] = useState<Preset>("hd_1080p");
  const [burn, setBurn] = useState(detail?.project.settings.subtitles.burnIn ?? true);
  const rendering = detail?.activeJobs.some((j) => j.type === "render_video") ?? false;

  const video = useMemo(() => (detail ? latestProjectAsset(detail.assets, detail.scenes, "video") : undefined), [detail]);
  const srt = useMemo(() => (detail ? latestProjectAsset(detail.assets, detail.scenes, "subtitle") : undefined), [detail]);
  const videoUrl = useAssetUrl(detail?.project.id, video?.id);
  const srtUrl = useAssetUrl(detail?.project.id, srt?.id);
  if (!detail) return null;

  const baseName = detail.project.name.replace(/[\\/:*?"<>|]+/g, "_");

  const render = async () => {
    const job = await actions.enqueue({
      type: "render_video",
      preset,
      burnSubtitles: burn && detail.project.settings.subtitles.enabled,
    });
    if (job) {
      toast(t.export.queued);
      onDone();
    }
  };

  const exportScript = async (format: "txt" | "md") => {
    try {
      downloadFile(await api.exportScript(detail.project.id, format), `${baseName}.${format}`);
      onDone();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div
      role="menu"
      className="absolute top-10 right-0 z-30 w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-2xl"
    >
      {video && videoUrl && (
        <a
          href={videoUrl}
          download={`${baseName}.mp4`}
          className={`${item} mb-1 bg-emerald-500/10 text-emerald-300`}
          onClick={onDone}
        >
          <Download className="size-4" aria-hidden />
          <span className="flex-1">{t.export.download}</span>
          <span className="text-[11px] text-neutral-400">
            {fmt(t.export.latestVideo, { time: formatRelativeTime(video.createdAt) })} · {formatBytes(video.sizeBytes)}
          </span>
        </a>
      )}
      <div className="rounded-md border border-neutral-800 p-2">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-100">
          <Film className="size-4" aria-hidden /> {t.export.video}
        </div>
        <fieldset className="mb-2 flex flex-col gap-1 text-xs text-neutral-300">
          <legend className="mb-1 text-neutral-500">{t.export.preset}</legend>
          {(["hd_1080p", "preview_540p"] as const).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input type="radio" name="preset" checked={preset === p} onChange={() => setPreset(p)} />
              {p === "hd_1080p" ? t.export.presetHd : t.export.presetPreview}
            </label>
          ))}
        </fieldset>
        <label className="mb-2 flex items-center gap-2 text-xs text-neutral-300">
          <input
            type="checkbox"
            checked={burn}
            disabled={!detail.project.settings.subtitles.enabled}
            onChange={(e) => setBurn(e.target.checked)}
          />
          {t.export.burnSubtitles}
        </label>
        <Button variant="primary" size="sm" className="w-full" disabled={rendering} onClick={() => void render()}>
          {t.export.start}
        </Button>
      </div>
      <div className="mt-1 flex flex-col">
        {srt && srtUrl ? (
          <a href={srtUrl} download={`${baseName}.srt`} className={item} onClick={onDone}>
            <Subtitles className="size-4" aria-hidden /> {t.export.srt}
          </a>
        ) : (
          <button type="button" className={item} disabled title={t.export.srtUnavailable}>
            <Subtitles className="size-4" aria-hidden /> {t.export.srt}
            <span className="ml-auto text-[11px] text-neutral-500">{t.export.srtUnavailable}</span>
          </button>
        )}
        <button type="button" className={item} onClick={() => void exportScript("txt")}>
          <FileText className="size-4" aria-hidden /> {t.export.scriptTxt}
        </button>
        <button type="button" className={item} onClick={() => void exportScript("md")}>
          <FileText className="size-4" aria-hidden /> {t.export.scriptMd}
        </button>
      </div>
    </div>
  );
}
