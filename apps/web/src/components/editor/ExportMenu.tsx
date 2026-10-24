import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, CostEstimate, Job } from "@lvs/shared";
import { AlertTriangle, Download, FileText, Film, Subtitles } from "lucide-react";
import { useApi, useAssetUrl } from "../../api/context";
import type { EditorActions } from "../../hooks/useEditorActions";
import { usePendingEstimate } from "../../hooks/usePendingEstimate";
import { fmt, t } from "../../i18n";
import { DOWNLOADED_EVENT, markDownloaded, wasDownloaded } from "../../lib/autoExport";
import { canChooseSaveLocation, formatBytes, formatRelativeTime, type saveFileAs } from "../../lib/format";
import { twdShort } from "../../lib/paidJobs";
import { saveWithToasts, VIDEO_FILE_TYPE } from "../../lib/saveFiles";
import { latestProjectAsset } from "../../lib/scenes";
import { pageRanges, visibleScenes } from "../../lib/settingsImpact";
import { useEditor } from "../../store/editorStore";
import { toast } from "../../store/toastStore";
import { Button } from "../ui/Button";
import { ProgressBar, Spinner } from "../ui/Misc";
import { etaText, useTick } from "./JobsDrawer";
import { OPEN_EXPORT_EVENT } from "./StepBar";

type Preset = "preview_540p" | "hd_1080p";

/** Shown in place of 開始匯出 while a render runs, so the click visibly did something. */
function RenderProgress({ job }: { job: Job }) {
  const now = useTick(2000, true);
  const eta = etaText(job, now);
  const pct = Math.round((job.progress ?? 0) * 100);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-accent-500/40 bg-accent-500/10 px-2 py-2 text-xs text-accent-100" role="status" data-testid="render-progress">
      <span className="flex items-center gap-1.5 font-medium">
        <Spinner className="size-3.5" />
        {fmt(t.export.rendering, { pct })}
        {eta && <span className="ml-auto font-normal text-neutral-400">{eta}</span>}
      </span>
      <ProgressBar value={job.progress ?? 0} indeterminate={job.status === "queued"} />
      <span className="text-neutral-400">{job.progressMessage ?? t.export.renderingHint}</span>
      <span className="text-neutral-400">{t.export.renderingNext}</span>
    </div>
  );
}

/** The latest video when it matches the current project and hasn't been saved from this browser yet. */
export function useFreshUndownloadedVideo(): Asset | undefined {
  const detail = useEditor((s) => s.detail);
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(DOWNLOADED_EVENT, on);
    return () => window.removeEventListener(DOWNLOADED_EVENT, on);
  }, []);
  if (!detail) return undefined;
  const video = latestProjectAsset(detail.assets, detail.scenes, "video");
  if (!video) return undefined;
  const current = detail.currentRenderHashes.length === 0 || detail.currentRenderHashes.includes(video.inputHash ?? "");
  return current && !wasDownloaded(video.id) ? video : undefined;
}

export function ExportMenu({ actions, disabled }: { actions: Pick<EditorActions, "enqueue">; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const renderJob = useEditor((s) => s.detail?.activeJobs.find((j) => j.type === "render_video"));
  const freshVideo = useFreshUndownloadedVideo();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EXPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EXPORT_EVENT, onOpen);
  }, []);

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
        data-testid="export-button"
        title={freshVideo && !renderJob ? t.export.readyToDownload : undefined}
      >
        {renderJob ? (
          <span className="flex items-center gap-1.5">
            <Spinner className="size-3.5 text-white" />
            {fmt(t.export.renderingShort, { pct: Math.round((renderJob.progress ?? 0) * 100) })}
          </span>
        ) : freshVideo ? (
          <span className="flex items-center gap-1.5" data-testid="export-ready">
            {t.export.readyShort}
            <span className="size-2 rounded-full bg-emerald-400 ring-2 ring-emerald-400/30" aria-hidden />
          </span>
        ) : (
          t.editor.export
        )}
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
  const renderJob = detail?.activeJobs.find((j) => j.type === "render_video");

  const video = useMemo(() => (detail ? latestProjectAsset(detail.assets, detail.scenes, "video") : undefined), [detail]);
  const srt = useMemo(() => (detail ? latestProjectAsset(detail.assets, detail.scenes, "subtitle") : undefined), [detail]);
  const videoUrl = useAssetUrl(detail?.project.id, video?.id);
  const srtUrl = useAssetUrl(detail?.project.id, srt?.id);

  const scenes = detail ? visibleScenes(detail).filter((s) => !s.muted) : [];
  const audioNotReady = scenes.filter((s) => s.audio.status !== "ready").map((s) => s.index + 1);
  const avatarNotReady =
    detail?.project.settings.avatar.enabled && detail.project.settings.avatar.avatarId
      ? scenes.filter((s) => s.avatar.status !== "ready").map((s) => s.index + 1)
      : [];
  const speechCost = usePendingEstimate(detail?.project.id, audioNotReady.length > 0 ? "synthesize_speech" : undefined);
  // The avatar job also makes any missing narration first, so its estimate covers both.
  const avatarCost = usePendingEstimate(detail?.project.id, avatarNotReady.length > 0 ? "generate_avatar" : undefined);
  if (!detail) return null;

  const videoOutdated =
    !!video && detail.currentRenderHashes.length > 0 && !detail.currentRenderHashes.includes(video.inputHash ?? "");
  const baseName = detail.project.name.replace(/[\\/:*?"<>|]+/g, "_");
  const renderRequest = {
    type: "render_video" as const,
    preset,
    burnSubtitles: burn && detail.project.settings.subtitles.enabled,
  };

  const render = async () => {
    const job = await actions.enqueue(renderRequest);
    // Stay open: the panel now shows the progress bar in place of 開始匯出.
    if (job) toast(t.export.queued);
  };

  // Make what's missing, then export: the server queues the render when that job succeeds, so
  // it happens even if this tab is closed in the meantime.
  const makeThenExport = async (type: "synthesize_speech" | "generate_avatar") => {
    const { type: _render, ...thenRender } = renderRequest;
    const job = await actions.enqueue({ type, force: false, thenRender });
    if (!job) return;
    toast(t.export.autoExportArmed);
    onDone();
  };

  const save = (source: Parameters<typeof saveFileAs>[0], filename: string, type: { description: string; mime: string }, big = false, onSaved?: () => void) => {
    onDone();
    return saveWithToasts(source, filename, type, big, onSaved);
  };

  const exportScript = (format: "txt" | "md") =>
    save(() => api.exportScript(detail.project.id, format), `${baseName}.${format}`, {
      description: format === "md" ? "Markdown" : t.export.textFile,
      mime: format === "md" ? "text/markdown" : "text/plain",
    });

  const costLabel = (e: CostEstimate | undefined) => (e ? twdShort(e.total, e.currency) : "…");

  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent";

  const preflightNote = (text: string) => (
    <p className="flex gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs whitespace-pre-line text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {text}
    </p>
  );

  return (
    <div
      role="menu"
      className="absolute top-10 right-0 z-30 w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-2xl"
    >
      {video && videoUrl && (
        <button
          type="button"
          className={`${item} mb-1 flex-wrap ${videoOutdated ? "bg-amber-500/10 text-amber-200" : "bg-emerald-500/10 text-emerald-300"}`}
          onClick={() => void save(videoUrl, `${baseName}.mp4`, VIDEO_FILE_TYPE, true, () => markDownloaded(video.id))}
          title={canChooseSaveLocation() ? t.export.chooseLocation : undefined}
          data-testid="download-video"
        >
          {videoOutdated ? <AlertTriangle className="size-4" aria-hidden /> : <Download className="size-4" aria-hidden />}
          <span className="flex-1">{videoOutdated ? t.export.downloadOld : t.export.download}</span>
          <span className="basis-full pl-6 text-xs text-neutral-400">
            {videoOutdated && <span className="text-amber-300/90">{t.export.outdated}・</span>}
            {fmt(videoOutdated ? t.export.lastVideo : t.export.latestVideo, { time: formatRelativeTime(video.createdAt) })} · {formatBytes(video.sizeBytes)}
          </span>
        </button>
      )}
      <div className="rounded-md border border-neutral-800 p-2">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-100">
          <Film className="size-4" aria-hidden /> {t.export.video}
        </div>
        <fieldset className="mb-2 flex flex-col gap-1 text-xs text-neutral-300" disabled={!!renderJob}>
          <legend className="mb-1 text-neutral-400">{t.export.preset}</legend>
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
            disabled={!detail.project.settings.subtitles.enabled || !!renderJob}
            onChange={(e) => setBurn(e.target.checked)}
          />
          {t.export.burnSubtitles}
        </label>
        {renderJob ? (
          // A running export always shows its progress, whatever else is still missing.
          <RenderProgress job={renderJob} />
        ) : audioNotReady.length > 0 && avatarNotReady.length > 0 ? (
          // Everything missing is listed at once: making only the narration would export a video
          // whose presenter disappears on these pages.
          <div className="flex flex-col gap-2" data-testid="export-preflight">
            {preflightNote(
              [
                t.export.preflightBoth,
                fmt(t.export.preflightBothAudio, { pages: pageRanges(audioNotReady), cost: costLabel(speechCost) }),
                fmt(t.export.preflightBothAvatar, { pages: pageRanges(avatarNotReady), cost: costLabel(avatarCost) }),
              ].join("\n"),
            )}
            <Button variant="primary" size="sm" className="w-full" onClick={() => void makeThenExport("generate_avatar")} data-testid="fix-all">
              {fmt(t.export.fixAllThenExport, { cost: costLabel(avatarCost) })}
            </Button>
            <Button size="sm" className="w-full" onClick={() => void makeThenExport("synthesize_speech")} data-testid="fix-audio">
              {fmt(t.export.fixAudioOnlyThenExport, { cost: costLabel(speechCost) })}
            </Button>
          </div>
        ) : audioNotReady.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="export-preflight">
            {preflightNote(fmt(t.export.preflightAudio, { pages: pageRanges(audioNotReady) }))}
            <Button variant="primary" size="sm" className="w-full" onClick={() => void makeThenExport("synthesize_speech")} data-testid="fix-audio">
              {fmt(t.export.fixAudioThenExport, { cost: costLabel(speechCost) })}
            </Button>
          </div>
        ) : avatarNotReady.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="export-preflight">
            {preflightNote(fmt(t.export.preflightAvatar, { pages: pageRanges(avatarNotReady) }))}
            <div className="flex gap-2">
              <Button variant="primary" size="sm" className="flex-1" onClick={() => void makeThenExport("generate_avatar")} data-testid="fix-avatar">
                {fmt(t.export.fixAvatarThenExport, { cost: costLabel(avatarCost) })}
              </Button>
              <Button size="sm" className="flex-1" onClick={() => void render()}>
                {t.export.exportAnyway}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" size="sm" className="w-full" onClick={() => void render()}>
            {t.export.start}
          </Button>
        )}
      </div>
      <div className="mt-1 flex flex-col">
        {srt && srtUrl ? (
          <button type="button" className={item} onClick={() => void save(srtUrl, `${baseName}.srt`, { description: t.export.srt, mime: "application/x-subrip" })}>
            <Subtitles className="size-4" aria-hidden /> {t.export.srt}
          </button>
        ) : (
          <button type="button" className={item} disabled title={t.export.srtUnavailable}>
            <Subtitles className="size-4" aria-hidden /> {t.export.srt}
            <span className="ml-auto text-xs text-neutral-400">{t.export.srtUnavailable}</span>
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
