import { useMemo } from "react";
import type { CostEstimate, EnqueueJobRequest, Job, ScriptRevision, UpdateProjectRequest, UpdateSceneRequest } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage, type EstimateType } from "../api/types";
import { fmt, t } from "../i18n";
import { requestNotifyPermission } from "../lib/notify";
import { avatarInVideo } from "@lvs/shared";
import {
  type AvatarLoss,
  confirmContent,
  ESTIMATED_TYPES,
  isForced,
  needsConfirm,
  needsConfirmWithoutEstimate,
  requestedScenes,
  twdShort,
  unknownEstimateContent,
} from "../lib/paidJobs";
import { pickLike, visibleScenes } from "../lib/settingsImpact";
import { confirmAction } from "../store/confirmStore";
import { editorStore } from "../store/editorStore";
import { toast } from "../store/toastStore";

export interface EnqueueOptions {
  /** false skips the estimate + confirmation (the caller already asked). */
  confirm?: boolean;
}

/** What a settings change makes stale: `audio` (voice, speed…) also stales avatars and subtitles. */
export type SettingsImpact = "audio" | "avatar" | "none";

type SettingsPatch = NonNullable<UpdateProjectRequest["settings"]>;

/** Jobs on the deck's pages (and the export), refused while a new deck is uploading. */
const UPLOAD_BLOCKED: ReadonlySet<string> = new Set(["generate_outline", "generate_script", "synthesize_speech", "generate_avatar", "translate_script", "render_video"]);

export const ACCEPTED_EXTENSIONS = [".pptx", ".ppt", ".pdf"];
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function validateUpload(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return t.upload.badType;
  if (file.size > MAX_UPLOAD_BYTES) return t.upload.tooLarge;
  return null;
}

/** Editor commands: call the API, apply the result to the store, report failures as toasts. */
/** Job types whose start is in progress in this tab (see enqueue). */
const inFlight = new Set<string>();

export function useEditorActions() {
  const api = useApi();

  return useMemo(() => {
    const projectId = () => {
      const id = editorStore.getState().detail?.project.id;
      if (!id) throw new Error("No project loaded");
      return id;
    };
    const store = () => editorStore.getState();
    // 「隱藏第 2 頁失敗：連不上伺服器…」: say which action failed, not just why.
    const failed = (action: string, err: unknown) => toast(fmt(t.actionFailed.toast, { action, message: errorMessage(err) }), "error");
    const pageNo = (sceneId: string) => (store().detail?.scenes.find((s) => s.id === sceneId)?.index ?? 0) + 1;
    const slidePageNo = (slideId: string) => (store().detail?.slides.find((s) => s.id === slideId)?.index ?? 0) + 1;

    /**
     * Starts a job. Paid/slow job types are estimated first (only the pages that would really be
     * processed); avatars, forced reruns and anything above the threshold need a confirmation.
     */
    /**
     * Redoing speech or scripts gives those pages new audio, and a presenter clip is made from the
     * audio: say how many paid clips would have to be made again, and roughly for how much.
     */
    const avatarLoss = async (req: EnqueueJobRequest): Promise<AvatarLoss | undefined> => {
      const detail = store().detail;
      if (!detail || !isForced(req) || (req.type !== "synthesize_speech" && req.type !== "generate_script")) return undefined;
      if (!avatarInVideo(detail.project.settings.avatar)) return undefined;
      const only = requestedScenes(req);
      const hit = visibleScenes(detail).filter((s) => !s.muted && s.avatar.status === "ready" && (!only || only.includes(s.id)));
      if (!hit.length) return undefined;
      let redo: CostEstimate | undefined;
      try {
        redo = await api.getEstimate(projectId(), "generate_avatar", { scope: "all", sceneIds: hit.map((s) => s.id) });
      } catch {
        redo = undefined;
      }
      return { pages: hit.length, ...(redo ? { redo } : {}) };
    };

    // A double click must not start the same job twice: while one request of a type is being
    // estimated, confirmed or sent, further clicks are ignored (the server refuses overlaps too).
    const enqueue = async (req: EnqueueJobRequest, options: EnqueueOptions = {}): Promise<Job | null> => {
      if (inFlight.has(req.type)) return null;
      inFlight.add(req.type);
      try {
        return await enqueueOnce(req, options);
      } finally {
        inFlight.delete(req.type);
      }
    };

    const enqueueOnce = async (req: EnqueueJobRequest, options: EnqueueOptions): Promise<Job | null> => {
      // The project this click belongs to: a confirmation can outlive the page (browser Back), and
      // must never start the job on whatever project is open by then.
      const pid = projectId();
      // A new deck still uploading: its pages are about to change (the server refuses too) — say so
      // before showing a price for the old pages.
      if (UPLOAD_BLOCKED.has(req.type) && store().upload.progress !== null) {
        toast(t.upload.uploadingBusy, "info");
        return null;
      }
      // Voices and a new outline never overlap (the readings could change under the voices): say so
      // before any price is shown (the server refuses too).
      const active = store().detail?.activeJobs ?? [];
      const voicing = active.find((j) => j.type === "synthesize_speech" || j.type === "generate_avatar");
      if ((req.type === "synthesize_speech" || req.type === "generate_avatar") && active.some((j) => j.type === "generate_outline")) {
        toast(t.jobs.waitForOutline, "info");
        return null;
      }
      if (req.type === "generate_outline" && voicing) {
        toast(fmt(t.jobs.waitForVoices, { job: t.jobs.types[voicing.type] }), "info");
        return null;
      }
      if (ESTIMATED_TYPES.has(req.type) && options.confirm !== false) {
        const type = req.type as EstimateType;
        let estimate: CostEstimate | null = null;
        try {
          estimate = await api.getEstimate(pid, type, { scope: isForced(req) ? "all" : "pending", sceneIds: requestedScenes(req) });
        } catch {
          estimate = null;
        }
        if (estimate?.replansOutline && voicing) {
          toast(fmt(t.jobs.waitForVoices, { job: t.jobs.types[voicing.type] }), "info");
          return null;
        }
        if (estimate?.sceneCount === 0) {
          toast(fmt(t.paid.nothingToDo, { job: t.jobs.types[type] }), "info");
          return null;
        }
        const avatarProvider = store().detail?.project.settings.avatar.providerId;
        const loss = await avatarLoss(req);
        if (estimate && (needsConfirm(req, estimate) || loss)) {
          const ok = await confirmAction(confirmContent(type, req, estimate, avatarProvider, loss));
          if (!ok) return null;
        } else if (!estimate && needsConfirmWithoutEstimate(req)) {
          // No estimate (network/API error) must never mean "start paid avatars unasked".
          const ok = await confirmAction(unknownEstimateContent(type, avatarProvider));
          if (!ok) return null;
        }
      }
      // Any job may outlast the user's attention (an export takes minutes too): ask once, now.
      requestNotifyPermission();
      try {
        if (store().detail?.project.id !== pid) return null;
        const { job } = await api.enqueueJob(pid, req);
        store().upsertJob(job);
        return job;
      } catch (err) {
        // Already running (another click, another tab): say so plainly, it's not a failure.
        if ((err as { status?: number }).status === 409) toast(errorMessage(err), "info");
        // 「產生語音失敗：…」 rather than the technical 「無法建立工作」.
        else failed(t.jobs.types[req.type], err);
        return null;
      }
    };

    const updateProject = async (req: UpdateProjectRequest): Promise<boolean> => {
      const detail = store().detail;
      if (!detail) return false;
      try {
        store().setProject(await api.updateProject(detail.project.id, req));
      } catch (err) {
        failed(req.name !== undefined ? t.actionFailed.rename : t.actionFailed.settings, err);
        return false;
      }
      // Page statuses (需更新) and render freshness are derived from settings on the server.
      if (req.settings) {
        try {
          const fresh = await api.getProject(detail.project.id);
          if (store().detail?.project.id === fresh.project.id) store().load(fresh);
        } catch {
          // The next event or reload catches up.
        }
      }
      return true;
    };

    /**
     * A settings change that may throw away generated audio/avatars. When finished avatars would
     * become 需更新 it asks first (they cost real money); afterwards it offers 復原. Statuses are
     * derived from input hashes, so restoring the old values makes those pages current again.
     */
    const changeSettings = async (settings: SettingsPatch, impact: SettingsImpact): Promise<boolean> => {
      const detail = store().detail;
      if (!detail) return false;
      const previous = pickLike(settings as Record<string, unknown>, detail.project.settings as unknown as Record<string, unknown>) as SettingsPatch;
      const scenes = visibleScenes(detail).filter((s) => !s.muted);
      const avatarReady = impact === "none" || !avatarInVideo(detail.project.settings.avatar) ? [] : scenes.filter((s) => s.avatar.status === "ready");
      const audioReady = impact === "audio" ? scenes.filter((s) => s.audio.status === "ready") : [];
      if (avatarReady.length > 0) {
        // The estimate is priced with the current settings: right for a new look or voice, wrong
        // when the presenter service itself changes (HeyGen → 本機人像 is free). Say that instead.
        const nextProvider = (settings as { avatar?: { providerId?: string } }).avatar?.providerId;
        const providerChanges = !!nextProvider && nextProvider !== detail.project.settings.avatar.providerId;
        let value = "";
        if (providerChanges) {
          value = nextProvider === "local" || nextProvider === "mock" ? t.impact.redoFree : "";
        } else {
          try {
            const est = await api.getEstimate(detail.project.id, "generate_avatar", { scope: "all", sceneIds: avatarReady.map((s) => s.id) });
            value = twdShort(est.total, est.currency);
          } catch {
            value = "";
          }
        }
        const ok = await confirmAction({
          title: t.impact.title,
          lines: [
            fmt(t.impact.avatarPages, { n: avatarReady.length }),
            ...(audioReady.length ? [fmt(t.impact.audioPages, { n: audioReady.length })] : []),
            ...(value ? [fmt(t.impact.redoCost, { cost: value })] : []),
          ],
          note: t.impact.note,
          confirmLabel: t.impact.confirm,
          danger: true,
        });
        if (!ok) return false;
      }
      const changed = await updateProject({ settings });
      if (changed && (avatarReady.length > 0 || audioReady.length > 0)) {
        toast(fmt(t.impact.done, { n: Math.max(avatarReady.length, audioReady.length) }), "info", {
          label: t.impact.undo,
          run: () => void updateProject({ settings: previous }),
        });
      }
      return changed;
    };

    const reorder = async (slideIds: string[], options: { undoable?: boolean } = {}): Promise<void> => {
      const before = store().detail;
      const previousOrder = before ? [...before.slides].sort((a, b) => a.index - b.index).map((s) => s.id) : undefined;
      store().reorderLocal(slideIds);
      try {
        const { slides, scenes } = await api.reorderSlides(projectId(), { slideIds });
        store().setSlidesAndScenes(slides, scenes);
        // A drag can move a page by accident; offer the way back.
        if (options.undoable !== false && previousOrder) {
          toast(t.pageList.reordered, "info", { label: t.impact.undo, run: () => void reorder(previousOrder, { undoable: false }) });
        }
      } catch (err) {
        if (before) store().setSlidesAndScenes(before.slides, before.scenes);
        failed(t.actionFailed.reorder, err);
      }
    };

    const saveScript = async (sceneId: string, text: string, options: { quiet?: boolean } = {}): Promise<void> => {
      const failedBefore = store().saveState[sceneId]?.status === "error";
      store().markSaving(sceneId);
      try {
        const rev = await api.updateScript(projectId(), sceneId, { script: text });
        store().markSaved(sceneId, rev, text);
      } catch (err) {
        store().markSaveError(sceneId, errorMessage(err));
        // The inline note is easy to miss: say it once, with a way to try again.
        if (!options.quiet && !failedBefore) {
          toast(fmt(t.script.saveFailedToast, { n: pageNo(sceneId), message: errorMessage(err) }), "error", {
            label: t.app.retry,
            run: () => {
              const draft = store().drafts[sceneId];
              if (draft !== undefined) void saveScript(sceneId, draft);
            },
          });
        }
      }
    };

    /**
     * Fix only the on-screen text of a page: script and narration text are sent unchanged, so the
     * server re-times the subtitles on the existing speech (no new speech, no new presenter).
     */
    const saveSubtitle = async (sceneId: string, revision: ScriptRevision, subtitleText: string): Promise<boolean> => {
      try {
        const rev = await api.updateScript(projectId(), sceneId, { script: revision.script, pronunciationText: revision.pronunciationText, subtitleText });
        store().markSaved(sceneId, rev, rev.script);
        toast(t.script.subtitleSaved);
        return true;
      } catch (err) {
        toast(fmt(t.script.subtitleSaveFailed, { message: errorMessage(err) }), "error");
        return false;
      }
    };

    return {
      enqueue,
      updateProject,
      changeSettings,

      saveScript,
      saveSubtitle,

      async cancelJob(jobId: string): Promise<void> {
        try {
          store().upsertJob(await api.cancelJob(projectId(), jobId));
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      },

      async updateScene(sceneId: string, req: UpdateSceneRequest): Promise<boolean> {
        try {
          store().upsertScene(await api.updateScene(projectId(), sceneId, req));
          return true;
        } catch (err) {
          failed(fmt(t.actionFailed.page, { n: pageNo(sceneId) }), err);
          return false;
        }
      },

      async setHidden(slideId: string, hidden: boolean): Promise<void> {
        try {
          store().upsertSlide(await api.setSlideHidden(projectId(), slideId, hidden));
        } catch (err) {
          failed(fmt(hidden ? t.actionFailed.hide : t.actionFailed.unhide, { n: slidePageNo(slideId) }), err);
        }
      },

      reorder,

      async upload(file: File): Promise<void> {
        // One upload at a time (a second click while a big deck is still going would race it).
        if (store().upload.progress !== null) return;
        // With a deck already shown, the drop zone (where upload.error appears) is hidden: also toast.
        const report = (message: string, retry?: () => void) => {
          store().setUpload({ progress: null, error: message });
          if (store().detail?.slides.length) toast(message, "error", retry ? { label: t.app.retry, run: retry } : undefined);
        };
        const invalid = validateUpload(file);
        if (invalid) {
          report(invalid);
          return;
        }
        // The upload keeps going if the user opens another project meanwhile: only ever show it
        // in its own project (else that project reads 「上傳中」 and refuses its jobs).
        const pid = projectId();
        const here = () => store().detail?.project.id === pid;
        const projectName = store().detail?.project.name ?? "";
        store().setUpload({ progress: 0, error: null });
        try {
          const { sourceDocument, job } = await api.uploadSource(pid, file, {
            onProgress: (progress) => {
              if (here()) store().setUpload({ progress, error: null });
            },
          });
          // Opened again later, the project loads the new deck and its parse from the server.
          if (!here()) return;
          // Job first: the preview treats a 「parsing」 document without a parse job as stopped.
          store().upsertJob(job);
          // The parse may already have finished (its events came first): keep that outcome.
          const done = store().recentJobs.find((j) => j.id === job.id);
          store().setSourceDocument(done ? { ...sourceDocument, parseStatus: done.status } : sourceDocument);
          store().setUpload({ progress: null, error: null });
        } catch (err) {
          if (here()) report(fmt(t.upload.failed, { message: errorMessage(err) }), () => void this.upload(file));
          // Another project is open by now: still say it, naming the project.
          else toast(fmt(t.upload.failedElsewhere, { project: projectName, message: errorMessage(err) }), "error");
        }
      },
    };
  }, [api]);
}

export type EditorActions = ReturnType<typeof useEditorActions>;
