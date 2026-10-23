import { useMemo } from "react";
import type { CostEstimate, EnqueueJobRequest, Job, UpdateProjectRequest, UpdateSceneRequest } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage, type EstimateType } from "../api/types";
import { fmt, t } from "../i18n";
import { formatCostTwd } from "../lib/format";
import { requestNotifyPermission } from "../lib/notify";
import {
  confirmContent,
  ESTIMATED_TYPES,
  estimateWaitSec,
  isForced,
  needsConfirm,
  needsConfirmWithoutEstimate,
  requestedScenes,
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

export const ACCEPTED_EXTENSIONS = [".pptx", ".ppt", ".pdf"];
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function validateUpload(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return t.upload.badType;
  if (file.size > MAX_UPLOAD_BYTES) return t.upload.tooLarge;
  return null;
}

/** Editor commands: call the API, apply the result to the store, report failures as toasts. */
export function useEditorActions() {
  const api = useApi();

  return useMemo(() => {
    const projectId = () => {
      const id = editorStore.getState().detail?.project.id;
      if (!id) throw new Error("No project loaded");
      return id;
    };
    const store = () => editorStore.getState();

    /**
     * Starts a job. Paid/slow job types are estimated first (only the pages that would really be
     * processed); avatars, forced reruns and anything above the threshold need a confirmation.
     */
    const enqueue = async (req: EnqueueJobRequest, options: EnqueueOptions = {}): Promise<Job | null> => {
      if (ESTIMATED_TYPES.has(req.type) && options.confirm !== false) {
        const type = req.type as EstimateType;
        let estimate: CostEstimate | null = null;
        try {
          estimate = await api.getEstimate(projectId(), type, { scope: isForced(req) ? "all" : "pending", sceneIds: requestedScenes(req) });
        } catch {
          estimate = null;
        }
        if (estimate?.sceneCount === 0) {
          toast(fmt(t.paid.nothingToDo, { job: t.jobs.types[type] }), "info");
          return null;
        }
        const avatarProvider = store().detail?.project.settings.avatar.providerId;
        if (estimate && needsConfirm(req, estimate)) {
          const ok = await confirmAction(confirmContent(type, req, estimate, avatarProvider));
          if (!ok) return null;
        } else if (!estimate && needsConfirmWithoutEstimate(req)) {
          // No estimate (network/API error) must never mean "start paid avatars unasked".
          const ok = await confirmAction(unknownEstimateContent(type, avatarProvider));
          if (!ok) return null;
        }
        if (estimate && estimateWaitSec(type, estimate, avatarProvider) > 90) requestNotifyPermission();
      }
      try {
        const { job } = await api.enqueueJob(projectId(), req);
        store().upsertJob(job);
        return job;
      } catch (err) {
        toast(fmt(t.jobs.enqueueFailed, { message: errorMessage(err) }), "error");
        return null;
      }
    };

    const updateProject = async (req: UpdateProjectRequest): Promise<boolean> => {
      const detail = store().detail;
      if (!detail) return false;
      try {
        store().setProject(await api.updateProject(detail.project.id, req));
      } catch (err) {
        toast(errorMessage(err), "error");
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
      const avatarReady = impact === "none" || !detail.project.settings.avatar.enabled ? [] : scenes.filter((s) => s.avatar.status === "ready");
      const audioReady = impact === "audio" ? scenes.filter((s) => s.audio.status === "ready") : [];
      if (avatarReady.length > 0) {
        let value = "";
        try {
          const est = await api.getEstimate(detail.project.id, "generate_avatar", { scope: "all", sceneIds: avatarReady.map((s) => s.id) });
          value = formatCostTwd(est.total, est.currency);
        } catch {
          value = "";
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
        toast(errorMessage(err), "error");
      }
    };

    return {
      enqueue,
      updateProject,
      changeSettings,

      async saveScript(sceneId: string, text: string): Promise<void> {
        store().markSaving(sceneId);
        try {
          const rev = await api.updateScript(projectId(), sceneId, { script: text });
          store().markSaved(sceneId, rev, text);
        } catch (err) {
          store().markSaveError(sceneId, errorMessage(err));
        }
      },

      async cancelJob(jobId: string): Promise<void> {
        try {
          store().upsertJob(await api.cancelJob(projectId(), jobId));
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      },

      async updateScene(sceneId: string, req: UpdateSceneRequest): Promise<void> {
        try {
          store().upsertScene(await api.updateScene(projectId(), sceneId, req));
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      },

      async setHidden(slideId: string, hidden: boolean): Promise<void> {
        try {
          store().upsertSlide(await api.setSlideHidden(projectId(), slideId, hidden));
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      },

      reorder,

      async upload(file: File): Promise<void> {
        const invalid = validateUpload(file);
        if (invalid) {
          store().setUpload({ progress: null, error: invalid });
          return;
        }
        store().setUpload({ progress: 0, error: null });
        try {
          const { sourceDocument, job } = await api.uploadSource(projectId(), file, {
            onProgress: (progress) => store().setUpload({ progress, error: null }),
          });
          store().setSourceDocument(sourceDocument);
          store().upsertJob(job);
          store().setUpload({ progress: null, error: null });
        } catch (err) {
          store().setUpload({ progress: null, error: fmt(t.upload.failed, { message: errorMessage(err) }) });
        }
      },
    };
  }, [api]);
}

export type EditorActions = ReturnType<typeof useEditorActions>;
