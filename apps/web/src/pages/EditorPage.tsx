import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router";
import { FileQuestion } from "lucide-react";
import type { ProjectEvent } from "@lvs/shared";
import { useApiEnv } from "../api/context";
import { RECONNECTING_EVENT } from "../api/client";
import { ApiRequestError, errorMessage } from "../api/types";
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
import { confirmDiscard, hasUnsaved } from "../lib/unsavedGuard";
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
      .catch((err: unknown) => {
        if (!alive) return;
        // A wrong or deleted project gets a plain explanation, not the API's English text.
        setError(err instanceof ApiRequestError && err.status === 404 ? t.editor.notFound : fmt(t.editor.loadFailed, { message: errorMessage(err) }));
      });
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

  // Unsaved glossary edits: any navigation away (a link, the gear, the browser's back) asks first.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsaved() && currentLocation.pathname !== nextLocation.pathname);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirmDiscard().then((ok) => (ok ? blockerRef.current.proceed?.() : blockerRef.current.reset?.()));
  }, [blocker.state]);

  // A save that got no response is retried for a few seconds: say so instead of staying silent.
  useEffect(() => {
    let last = 0;
    const onReconnecting = () => {
      if (Date.now() - last < 10_000) return;
      last = Date.now();
      toast(t.actionFailed.reconnecting, "info");
    };
    window.addEventListener(RECONNECTING_EVENT, onReconnecting);
    return () => window.removeEventListener(RECONNECTING_EVENT, onReconnecting);
  }, []);

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
      <div className="flex h-full items-center justify-center bg-neutral-950 p-6">
        <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center" role="alert">
          <FileQuestion className="mx-auto mb-3 size-8 text-neutral-400" aria-hidden />
          <p className="text-sm text-neutral-200">{error}</p>
          <Link to="/" className="mt-4 inline-flex items-center rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-500">
            {t.app.backToProjects}
          </Link>
        </div>
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
