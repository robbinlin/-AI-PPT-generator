import { useMemo } from "react";
import type { EnqueueJobRequest, Job, UpdateProjectRequest, UpdateSceneRequest } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage } from "../api/types";
import { fmt, t } from "../i18n";
import { editorStore } from "../store/editorStore";
import { toast } from "../store/toastStore";

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

    const enqueue = async (req: EnqueueJobRequest): Promise<Job | null> => {
      try {
        const { job } = await api.enqueueJob(projectId(), req);
        store().upsertJob(job);
        return job;
      } catch (err) {
        toast(fmt(t.jobs.enqueueFailed, { message: errorMessage(err) }), "error");
        return null;
      }
    };

    return {
      enqueue,

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

      async updateProject(req: UpdateProjectRequest): Promise<void> {
        const detail = store().detail;
        if (!detail) return;
        try {
          store().setProject(await api.updateProject(detail.project.id, req));
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

      async reorder(slideIds: string[]): Promise<void> {
        const before = store().detail;
        store().reorderLocal(slideIds);
        try {
          const { slides, scenes } = await api.reorderSlides(projectId(), { slideIds });
          store().setSlidesAndScenes(slides, scenes);
        } catch (err) {
          if (before) store().setSlidesAndScenes(before.slides, before.scenes);
          toast(errorMessage(err), "error");
        }
      },

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
