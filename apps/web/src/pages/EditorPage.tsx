import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { ProjectEvent } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage } from "../api/types";
import { CenterPane } from "../components/editor/CenterPane";
import { EditorHeader } from "../components/editor/EditorHeader";
import { JobsDrawer } from "../components/editor/JobsDrawer";
import { PageList } from "../components/editor/PageList";
import { RightPanel } from "../components/editor/RightPanel";
import { Spinner } from "../components/ui/Misc";
import { useEditorActions } from "../hooks/useEditorActions";
import { useEditorKeyboard } from "../hooks/useEditorKeyboard";
import { useScriptAutosave } from "../hooks/useScriptAutosave";
import { fmt, t } from "../i18n";
import { editorStore, useEditor } from "../store/editorStore";

export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const api = useApi();
  const actions = useEditorActions();
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
    });

    refresh().catch((err: unknown) => alive && setError(errorMessage(err)));
    api.listJobs(projectId).then(
      (jobs) => alive && editorStore.getState().setRecentJobs(jobs),
      () => undefined,
    );

    return () => {
      alive = false;
      unsubscribe();
      editorStore.getState().stopPlayback();
    };
  }, [api, projectId]);

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
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_380px]">
        <PageList actions={actions} />
        <CenterPane onUpload={(file) => void actions.upload(file)} />
        <RightPanel actions={actions} />
      </div>
      <JobsDrawer open={jobsOpen} onClose={closeJobs} actions={actions} />
    </div>
  );
}
