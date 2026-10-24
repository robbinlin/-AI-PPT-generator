import { useEffect, useMemo, useRef, useState } from "react";
import { avatarInVideo } from "@lvs/shared";
import type { Asset, CostEstimate, Job } from "@lvs/shared";
import { AlertTriangle, Download, FileText, Film, Subtitles } from "lucide-react";
import { useApi, useAssetUrl } from "../../api/context";
import type { EditorActions } from "../../hooks/useEditorActions";
import { usePendingEstimate } from "../../hooks/usePendingEstimate";
import { fmt, t } from "../../i18n";
import { DOWNLOADED_EVENT, markDownloaded, wasDownloaded } from "../../lib/autoExport";
import { canChooseSaveLocation, formatBytes, formatRelativeTime, formatWait, type saveFileAs } from "../../lib/format";
import { estimateWaitSec, twdShort } from "../../lib/paidJobs";
import { saveWithToasts, VIDEO_FILE_TYPE, videoFileName } from "../../lib/saveFiles";
import { isVideoCurrent, latestProjectAsset } from "../../lib/scenes";
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
    <div
      ref={(el) => {
        // 開始匯出 is replaced by this block: keep keyboard focus here instead of losing it.
        if (el && (!document.activeElement || document.activeElement === document.body)) el.focus();
      }}
      tabIndex={-1}
      className="flex flex-col gap-1.5 rounded-md border border-accent-500/40 bg-accent-500/10 px-2 py-2 text-xs text-accent-100 focus:outline-none"
      role="status"
      data-testid="render-progress"
    >
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
  const current = isVideoCurrent(detail.currentRenderHashes, video);
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
    const button = ref.current?.querySelector<HTMLElement>("[data-testid=export-button]");
    // A popup panel (not a menu): focus moves to its first control, Esc returns it to the button.
    const timer = setTimeout(() => {
      ref.current?.querySelector<HTMLElement>('[data-export-panel] button:not([disabled]), [data-export-panel] input:not([disabled])')?.focus();
    }, 0);
    // Clicks in a confirmation opened from the panel (e.g. 全部做完再匯出) must not close it.
    const inModal = (target: EventTarget | null) => target instanceof Element && !!target.closest("[role=dialog][aria-modal=true]");
    const onDown = (e: MouseEvent) => {
      if (inModal(e.target)) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[role=dialog][aria-modal=true]")) return;
      setOpen(false);
      button?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      // Tabbing out of the panel closes it, so it never covers the control that now has focus.
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!open || !next || ref.current?.contains(next) || document.querySelector("[role=dialog][aria-modal=true]")) return;
        setOpen(false);
      }}
    >
      <Button
        variant="primary"
        icon={Film}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
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
  // A finished export replaces the progress block: hand keyboard focus to 下載影片.
  const lastVideoId = useRef(video?.id);
  useEffect(() => {
    if (!video || video.id === lastVideoId.current || !videoUrl) return;
    lastVideoId.current = video.id;
    const active = document.activeElement;
    const panel = document.querySelector("[data-export-panel]");
    if (!active || active === document.body || panel?.contains(active)) {
      document.querySelector<HTMLElement>("[data-testid=download-video]")?.focus();
    }
  }, [video, videoUrl]);
  const srtUrl = useAssetUrl(detail?.project.id, srt?.id);

  const scenes = detail ? visibleScenes(detail).filter((s) => !s.muted) : [];
  // A page with no script cannot get narration: that is the real thing to fix first.
  const noScript = scenes.filter((s) => s.script.status === "missing" || !detail?.scripts[s.id]?.script.trim());
  const audioNotReady = scenes.filter((s) => s.audio.status !== "ready").map((s) => s.index + 1);
  const avatarNotReady =
    detail && avatarInVideo(detail.project.settings.avatar)
      ? scenes.filter((s) => s.avatar.status !== "ready").map((s) => s.index + 1)
      : [];
  const speechCost = usePendingEstimate(detail?.project.id, audioNotReady.length > 0 ? "synthesize_speech" : undefined);
  // The avatar job also makes any missing narration first, so its estimate covers both.
  const avatarCost = usePendingEstimate(detail?.project.id, avatarNotReady.length > 0 ? "generate_avatar" : undefined);
  if (!detail) return null;

  const videoOutdated =
    !!video && !isVideoCurrent(detail.currentRenderHashes, video);
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
      role="dialog"
      aria-label={t.export.menu}
      data-export-panel
      className="absolute top-10 right-0 z-30 w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-2xl"
    >
      {video && videoUrl && (
        <button
          type="button"
          className={`${item} mb-1 flex-wrap ${videoOutdated ? "bg-amber-500/10 text-amber-200" : "bg-emerald-500/10 text-emerald-300"}`}
          onClick={() => void save(videoUrl, videoFileName(detail?.project.name ?? baseName, video, videoOutdated), VIDEO_FILE_TYPE, true, () => markDownloaded(video.id))}
          title={canChooseSaveLocation() ? t.export.chooseLocation : undefined}
          data-testid="download-video"
        >
          {videoOutdated ? <AlertTriangle className="size-4" aria-hidden /> : <Download className="size-4" aria-hidden />}
          <span className="flex-1">{videoOutdated ? t.export.downloadOld : t.export.download}</span>
          <span className="basis-full pl-6 text-xs text-neutral-400">
            {videoOutdated && <span className="text-amber-300/90">{t.export.outdated}・</span>}
            {fmt(videoOutdated ? t.export.lastVideo : t.export.latestVideo, { time: formatRelativeTime(video.createdAt) })}・{formatBytes(video.sizeBytes)}
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
          {/* A choice for this export only; the project's own setting lives in 人像與聲音. */}
          {t.export.burnSubtitlesOnce}
        </label>
        {detail.project.settings.subtitles.enabled && burn !== detail.project.settings.subtitles.burnIn && (
          <p className="-mt-1 mb-2 text-xs text-amber-300">{burn ? t.export.burnDiffersOn : t.export.burnDiffersOff}</p>
        )}
        {renderJob ? (
          // A running export always shows its progress, whatever else is still missing.
          <RenderProgress job={renderJob} />
        ) : noScript.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="export-preflight">
            {preflightNote(fmt(t.export.preflightScript, { pages: pageRanges(noScript.map((s) => s.index + 1)) }))}
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              onClick={() => {
                onDone();
                void actions.enqueue({ type: "generate_script", force: false, sceneIds: noScript.map((s) => s.id) });
              }}
              data-testid="fix-script"
            >
              {t.export.fixScript}
            </Button>
          </div>
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
              {fmt(t.export.fixAudioOnlyThenExport, { cost: costLabel(speechCost), these: avatarNotReady.length === 1 ? t.export.thisPage : t.export.thesePages })}
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
            {preflightNote(fmt(t.export.preflightAvatar, { pages: pageRanges(avatarNotReady), these: avatarNotReady.length === 1 ? t.export.thisPage : t.export.thesePages }))}
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
          // A current video is done: downloading it is the main action, exporting again the side one.
          <>
            <Button variant={video && !videoOutdated ? "secondary" : "primary"} size="sm" className="w-full" onClick={() => void render()} data-testid="start-export">
              {video && !videoOutdated ? t.export.reexport : t.export.start}
            </Button>
            {/* How long the free local export takes, before it starts. */}
            <p className="mt-1 text-center text-xs text-neutral-400" data-testid="export-wait">
              {fmt(t.export.waitEstimate, { wait: formatWait(estimateWaitSec("render_video", { seconds: detail.totalDurationSec, sceneCount: visibleScenes(detail).length } as CostEstimate) * (preset === "preview_540p" ? 0.5 : 1)) })}
            </p>
          </>
        )}
      </div>
      <div className="mt-1 flex flex-col">
        {srt && srtUrl ? (
          // The subtitles belong to the last export: named and labelled like its video.
          <button
            type="button"
            className={item}
            onClick={() => void save(srtUrl, video ? videoFileName(detail.project.name, video, !!videoOutdated).replace(/\.mp4$/, ".srt") : `${baseName}.srt`, { description: t.export.srt, mime: "application/x-subrip" })}
          >
            <Subtitles className="size-4" aria-hidden /> {t.export.srt}
            {videoOutdated && <span className="ml-auto text-xs text-amber-300">{t.export.srtOld}</span>}
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
