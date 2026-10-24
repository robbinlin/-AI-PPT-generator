import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { ProjectEvent } from "@lvs/shared";
import { useApiEnv } from "../api/context";
import { errorMessage } from "../api/types";
import { ConfirmHost } from "../components/ConfirmHost";
import { CenterPane } from "../components/editor/CenterPane";
import { EditorHeader } from "../components/editor/EditorHeader";
import { saveVideo } from "../lib/saveFiles";
import { JobsDrawer } from "../components/editor/JobsDrawer";
import { PageList } from "../components/editor/PageList";
import { RightPanel } from "../components/editor/RightPanel";
import { StepBar } from "../components/editor/StepBar";
import { Spinner } from "../components/ui/Misc";
import { useEditorActions } from "../hooks/useEditorActions";
import { useEditorKeyboard } from "../hooks/useEditorKeyboard";
import { useScriptAutosave } from "../hooks/useScriptAutosave";
import { fmt, t } from "../i18n";
import { friendlyJobError } from "../lib/jobErrors";
import { notifyIfHidden } from "../lib/notify";
import { takePendingUpload } from "../lib/pendingUpload";
import { editorStore, useEditor } from "../store/editorStore";
import { toast } from "../store/toastStore";

export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { client: api, assetUrls } = useApiEnv();
  const actions = useEditorActions();
  // The event handler below lives as long as the project; it reads the latest actions from here.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const loaded = useEditor((s) => s.detail?.project.id === projectId);
  const drafts = useEditor((s) => s.drafts);
  const dirty = useEditor((s) => s.dirty);
  const [error, setError] = useState<string | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);

  // Load the project and follow its event stream. Events that arrive before the snapshot are
  // buffered and replayed on top of it.
  useEffect(() => {
    if (!projectId) return;
    const store = editorStore.getState();
    store.reset();
    setError(null);
    let ready = false;
    let alive = true;
    const buffer: ProjectEvent[] = [];
    // Jobs already reported, so repeated events for one job toast once.
    const announced = new Set<string>();

    const refresh = () =>
      api.getProject(projectId).then((detail) => {
        if (!alive) return;
        editorStore.getState().load(detail);
        ready = true;
        for (const e of buffer.splice(0)) editorStore.getState().applyEvent(e);
      });

    const unsubscribe = api.subscribe(projectId, (event) => {
      if (!ready) {
        buffer.push(event);
        return;
      }
      editorStore.getState().applyEvent(event);
      // There is no SourceDocument event: after a parse finishes, take a fresh snapshot.
      if (event.kind === "job" && event.job.type === "parse_document" && event.job.status === "succeeded") {
        void refresh().catch(() => undefined);
      }
      // A failed job otherwise only shows in the jobs drawer, which reads as "nothing happened".
      if (event.kind === "job" && event.job.status === "failed" && !announced.has(event.job.id)) {
        announced.add(event.job.id);
        const message = fmt(t.jobs.failedToast, { type: t.jobs.types[event.job.type], message: friendlyJobError(event.job.error) ?? event.job.error ?? "" });
        toast(message, "error");
        notifyIfHidden(message, editorStore.getState().detail?.project.name ?? "");
      }
      // Long jobs (HeyGen takes minutes) need a visible "done", also when the tab is in the background.
      if (event.kind === "job" && event.job.status === "succeeded" && event.job.type !== "parse_document" && event.job.type !== "export_script" && !announced.has(event.job.id)) {
        announced.add(event.job.id);
        const type = t.jobs.types[event.job.type];
        const videoAssetId = event.job.type === "render_video" ? (event.job.result as { videoAssetId?: string } | undefined)?.videoAssetId : undefined;
        if (videoAssetId) {
          // Resolve the URL first so the click on 下載影片 opens the save dialog right away.
          const name = editorStore.getState().detail?.project.name ?? "video";
          void assetUrls.get(projectId, videoAssetId).then(
            (url) => toast(t.export.readyToast, "success", { label: t.export.readyAction, run: () => void saveVideo(url, name, videoAssetId) }, 120_000),
            () => toast(fmt(t.jobs.doneToast, { type }), "success"),
          );
        } else {
          toast(fmt(t.jobs.doneToast, { type }), "success");
        }
        notifyIfHidden(fmt(t.jobs.doneToast, { type }), fmt(t.jobs.notifyBody, { name: editorStore.getState().detail?.project.name ?? "", type }));
      }
    });

    refresh()
      .then(() => {
        // A deck picked in the new-project dialog: upload it now that the editor shows progress.
        const file = alive ? takePendingUpload(projectId) : undefined;
        if (file) void actionsRef.current.upload(file);
      })
      .catch((err: unknown) => alive && setError(errorMessage(err)));
    api.listJobs(projectId).then(
      (jobs) => alive && editorStore.getState().setRecentJobs(jobs),
      () => undefined,
    );

    return () => {
      alive = false;
      unsubscribe();
      editorStore.getState().stopPlayback();
    };
  }, [api, assetUrls, projectId]);

  useScriptAutosave(drafts, actions.saveScript);

  // Warn before closing the tab with unsaved script edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEditorKeyboard({
    onPrev: useCallback(() => editorStore.getState().selectRelative(-1), []),
    onNext: useCallback(() => editorStore.getState().selectRelative(1), []),
    onTogglePlay: useCallback(() => editorStore.getState().togglePlaying(), []),
  });

  const closeJobs = useCallback(() => setJobsOpen(false), []);

  if (error) {
    return (
      <div className="mx-auto max-w-md py-24 text-center text-sm">
        <p className="text-rose-300">{fmt(t.editor.loadFailed, { message: error })}</p>
        <Link to="/" className="mt-3 inline-block text-accent-400 hover:underline">
          {t.app.backToProjects}
        </Link>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-neutral-400">
        <Spinner /> {t.app.loading}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <EditorHeader actions={actions} onOpenJobs={() => setJobsOpen(true)} />
      <StepBar actions={actions} />
      <div className="grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)_330px] min-[1360px]:grid-cols-[260px_minmax(0,1fr)_380px]">
        <PageList actions={actions} />
        <CenterPane onUpload={(file) => void actions.upload(file)} actions={actions} />
        <RightPanel actions={actions} />
      </div>
      <JobsDrawer open={jobsOpen} onClose={closeJobs} actions={actions} />
      <ConfirmHost />
    </div>
  );
}
