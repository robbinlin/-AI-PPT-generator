import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { Job, Project, ProjectDetail, ProjectEvent, Scene, ScriptRevision, Slide, SourceDocument } from "@lvs/shared";
import { fmt, t } from "../i18n";
import { sortByIndex } from "../lib/scenes";
import { toast } from "./toastStore";
import { applyJob, applyProjectEvent, applyScene, applySlides, isActiveJob } from "./reducer";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface ScriptHistory {
  past: string[];
  future: string[];
}

export interface SaveState {
  status: SaveStatus;
  error?: string;
}

export interface PlaybackState {
  playing: boolean;
  /** "播放全部": when the current scene ends, advance to the next playable scene. */
  playAll: boolean;
  /** Position of the current scene's narration, so the preview can show the matching subtitle. */
  currentTime: number;
}

export interface UploadState {
  /** 0..1 while the file is being sent; null otherwise. */
  progress: number | null;
  error: string | null;
}

const HISTORY_LIMIT = 200;
const RECENT_JOBS_LIMIT = 20;

export interface EditorState {
  detail: ProjectDetail | null;
  selectedSceneId: string | null;
  /** Unsaved script text per scene (optimistic edits). Absent = matches the saved revision. */
  drafts: Record<string, string>;
  history: Record<string, ScriptHistory>;
  saveState: Record<string, SaveState>;
  /** True while any script draft has not been persisted. */
  dirty: boolean;
  /** Jobs that finished while the editor was open, newest first. */
  recentJobs: Job[];
  playback: PlaybackState;
  upload: UploadState;

  load(detail: ProjectDetail): void;
  reset(): void;
  applyEvent(event: ProjectEvent): void;

  select(sceneId: string | null): void;
  selectRelative(delta: number): void;
  /** Selects the next scene that has audio and is neither hidden nor muted. */
  advanceToNextPlayable(): boolean;

  editScript(sceneId: string, text: string): void;
  undo(sceneId: string): void;
  redo(sceneId: string): void;
  markSaving(sceneId: string): void;
  markSaved(sceneId: string, revision: ScriptRevision, sentText: string): void;
  markSaveError(sceneId: string, message: string): void;

  setProject(project: Project): void;
  setSourceDocument(source: SourceDocument): void;
  upsertSlide(slide: Slide): void;
  upsertScene(scene: Scene): void;
  setSlidesAndScenes(slides: Slide[], scenes: Scene[]): void;
  /** Optimistic reorder; the server response replaces it. */
  reorderLocal(slideIds: string[]): void;
  upsertJob(job: Job): void;
  setRecentJobs(jobs: Job[]): void;

  setUpload(upload: UploadState): void;

  setPlaying(playing: boolean): void;
  setCurrentTime(sec: number): void;
  togglePlaying(): void;
  startPlayAll(): void;
  stopPlayback(): void;
}

export function savedScript(state: Pick<EditorState, "detail">, sceneId: string): string {
  return state.detail?.scripts[sceneId]?.script ?? "";
}

/** The text the editor shows for a scene: the draft if any, else the saved revision. */
export function currentScript(state: Pick<EditorState, "detail" | "drafts">, sceneId: string): string {
  return state.drafts[sceneId] ?? savedScript(state, sceneId);
}

export function orderedScenes(detail: ProjectDetail | null): Scene[] {
  return detail ? sortByIndex(detail.scenes) : [];
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function pushBounded(stack: readonly string[], value: string): string[] {
  const next = [...stack, value];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

function rememberJob(recent: readonly Job[], job: Job): Job[] {
  return [job, ...recent.filter((j) => j.id !== job.id)].slice(0, RECENT_JOBS_LIMIT);
}

const initial = {
  detail: null,
  selectedSceneId: null,
  drafts: {},
  history: {},
  saveState: {},
  dirty: false,
  recentJobs: [],
  playback: { playing: false, playAll: false, currentTime: 0 },
  upload: { progress: null, error: null },
} satisfies Partial<EditorState>;

export function createEditorStore(): StoreApi<EditorState> {
  return createStore<EditorState>()((set, get) => {
    /** Sets the draft for a scene, dropping it when it equals the saved text. */
    const draftsWith = (state: EditorState, sceneId: string, text: string): Record<string, string> =>
      text === savedScript(state, sceneId) ? withoutKey(state.drafts, sceneId) : { ...state.drafts, [sceneId]: text };

    const updateDetail = (fn: (d: ProjectDetail) => ProjectDetail) => {
      const { detail } = get();
      if (detail) set({ detail: fn(detail) });
    };

    return {
      ...initial,

      load(detail) {
        const prev = get();
        const sameProject = prev.detail?.project.id === detail.project.id;
        const scenes = sortByIndex(detail.scenes);
        const keepSelection = sameProject && scenes.some((s) => s.id === prev.selectedSceneId);
        set({
          detail,
          selectedSceneId: keepSelection ? prev.selectedSceneId : (scenes[0]?.id ?? null),
          ...(sameProject
            ? {}
            : {
                drafts: {},
                history: {},
                saveState: {},
                dirty: false,
                recentJobs: [],
                playback: initial.playback,
                upload: initial.upload,
              }),
        });
      },

      reset() {
        set({ ...initial });
      },

      applyEvent(event) {
        const state = get();
        if (!state.detail) return;
        const detail = applyProjectEvent(state.detail, event);
        if (detail === state.detail) return;
        const patch: Partial<EditorState> = { detail };

        if (event.kind === "job" && !isActiveJob(event.job)) {
          patch.recentJobs = rememberJob(state.recentJobs, event.job);
        }

        if (event.kind === "script") {
          const { sceneId, script, source } = event.script;
          const draft = state.drafts[sceneId];
          const previousText = savedScript(state, sceneId);
          if (draft !== undefined && draft === script) {
            patch.drafts = withoutKey(state.drafts, sceneId);
          } else if (source !== "user" && (draft ?? previousText) !== script) {
            // An AI rewrite or translation replaces whatever was there; keep it undoable.
            const h = state.history[sceneId] ?? { past: [], future: [] };
            patch.history = { ...state.history, [sceneId]: { past: pushBounded(h.past, draft ?? previousText), future: [] } };
            patch.drafts = withoutKey(state.drafts, sceneId);
          }
          if (patch.drafts) patch.dirty = Object.keys(patch.drafts).length > 0;
        }

        // The deck was replaced elsewhere (another tab): drafts of pages that no longer exist can
        // never be saved. Drop them (so leaving doesn't keep asking) but offer their text.
        if (event.kind === "slides") {
          const alive = new Set(detail.scenes.map((s) => s.id));
          const orphans = Object.entries(state.drafts).filter(([id]) => !alive.has(id));
          if (orphans.length) {
            patch.drafts = Object.fromEntries(Object.entries(state.drafts).filter(([id]) => alive.has(id)));
            patch.saveState = Object.fromEntries(Object.entries(state.saveState).filter(([id]) => alive.has(id)));
            patch.dirty = Object.keys(patch.drafts).length > 0;
            const text = orphans.map(([, v]) => v).join("\n\n");
            toast(fmt(t.editor.orphanDrafts, { n: orphans.length }), "info", {
              label: t.editor.copyText,
              run: () => void navigator.clipboard?.writeText(text).catch(() => undefined),
            }, 60_000);
          }
        }

        if (event.kind === "slides" && state.selectedSceneId) {
          if (!detail.scenes.some((s) => s.id === state.selectedSceneId)) {
            patch.selectedSceneId = sortByIndex(detail.scenes)[0]?.id ?? null;
          }
        } else if (event.kind === "slides" && !state.selectedSceneId) {
          patch.selectedSceneId = sortByIndex(detail.scenes)[0]?.id ?? null;
        }
        set(patch);
      },

      select(sceneId) {
        set({ selectedSceneId: sceneId });
      },

      selectRelative(delta) {
        const { detail, selectedSceneId } = get();
        const scenes = orderedScenes(detail);
        if (scenes.length === 0) return;
        const i = scenes.findIndex((s) => s.id === selectedSceneId);
        const next = Math.max(0, Math.min(scenes.length - 1, i === -1 ? 0 : i + delta));
        const target = scenes[next];
        if (target) set({ selectedSceneId: target.id });
      },

      advanceToNextPlayable() {
        const { detail, selectedSceneId } = get();
        if (!detail) return false;
        const hidden = new Set(detail.slides.filter((s) => s.hidden).map((s) => s.id));
        const scenes = orderedScenes(detail);
        const start = scenes.findIndex((s) => s.id === selectedSceneId);
        const next = scenes.slice(start + 1).find((s) => !hidden.has(s.slideId) && !s.muted && s.audio.assetId !== undefined);
        if (!next) return false;
        set({ selectedSceneId: next.id });
        return true;
      },

      editScript(sceneId, text) {
        const state = get();
        const current = currentScript(state, sceneId);
        if (text === current) return;
        const h = state.history[sceneId] ?? { past: [], future: [] };
        const drafts = draftsWith(state, sceneId, text);
        set({
          drafts,
          dirty: Object.keys(drafts).length > 0,
          history: { ...state.history, [sceneId]: { past: pushBounded(h.past, current), future: [] } },
        });
      },

      undo(sceneId) {
        const state = get();
        const h = state.history[sceneId];
        const previous = h?.past[h.past.length - 1];
        if (!h || previous === undefined) return;
        const current = currentScript(state, sceneId);
        const drafts = draftsWith(state, sceneId, previous);
        set({
          drafts,
          dirty: Object.keys(drafts).length > 0,
          history: { ...state.history, [sceneId]: { past: h.past.slice(0, -1), future: [...h.future, current] } },
        });
      },

      redo(sceneId) {
        const state = get();
        const h = state.history[sceneId];
        const nextText = h?.future[h.future.length - 1];
        if (!h || nextText === undefined) return;
        const current = currentScript(state, sceneId);
        const drafts = draftsWith(state, sceneId, nextText);
        set({
          drafts,
          dirty: Object.keys(drafts).length > 0,
          history: { ...state.history, [sceneId]: { past: pushBounded(h.past, current), future: h.future.slice(0, -1) } },
        });
      },

      markSaving(sceneId) {
        set((s) => ({ saveState: { ...s.saveState, [sceneId]: { status: "saving" } } }));
      },

      markSaved(sceneId, revision, sentText) {
        const state = get();
        if (!state.detail) return;
        const current = state.detail.scripts[sceneId];
        const scripts =
          current && current.version > revision.version ? state.detail.scripts : { ...state.detail.scripts, [sceneId]: revision };
        const drafts = state.drafts[sceneId] === sentText ? withoutKey(state.drafts, sceneId) : state.drafts;
        set({
          detail: { ...state.detail, scripts },
          drafts,
          dirty: Object.keys(drafts).length > 0,
          saveState: { ...state.saveState, [sceneId]: { status: "saved" } },
        });
      },

      markSaveError(sceneId, message) {
        set((s) => ({ saveState: { ...s.saveState, [sceneId]: { status: "error", error: message } } }));
      },

      setProject(project) {
        updateDetail((d) => ({ ...d, project }));
      },

      setSourceDocument(sourceDocument) {
        updateDetail((d) => ({ ...d, sourceDocument }));
      },

      upsertSlide(slide) {
        updateDetail((d) =>
          applySlides(
            d,
            d.slides.map((s) => (s.id === slide.id ? slide : s)),
            d.scenes,
          ),
        );
      },

      upsertScene(scene) {
        updateDetail((d) => applyScene(d, scene));
      },

      setSlidesAndScenes(slides, scenes) {
        updateDetail((d) => applySlides(d, slides, scenes));
      },

      reorderLocal(slideIds) {
        updateDetail((d) => {
          const pos = new Map(slideIds.map((id, i) => [id, i]));
          const slides = d.slides.map((s) => ({ ...s, index: pos.get(s.id) ?? s.index }));
          const scenes = d.scenes.map((s) => ({ ...s, index: pos.get(s.slideId) ?? s.index }));
          return applySlides(d, slides, scenes);
        });
      },

      upsertJob(job) {
        const state = get();
        if (!state.detail) return;
        // A response can arrive after the job's own events: never put a finished job back to
        // 「queued」, nor a running one back to queued.
        const finished = state.recentJobs.find((j) => j.id === job.id);
        if (finished && isActiveJob(job)) return;
        const live = state.detail.activeJobs.find((j) => j.id === job.id);
        if (live && live.status === "running" && job.status === "queued") return;
        set({
          detail: applyJob(state.detail, job),
          ...(isActiveJob(job) ? {} : { recentJobs: rememberJob(state.recentJobs, job) }),
        });
      },

      setRecentJobs(jobs) {
        set({ recentJobs: jobs.filter((j) => !isActiveJob(j)).slice(0, RECENT_JOBS_LIMIT) });
      },

      setUpload(upload) {
        set({ upload });
      },

      setPlaying(playing) {
        set((s) => ({ playback: { ...s.playback, playing, playAll: playing ? s.playback.playAll : false } }));
      },

      setCurrentTime(sec) {
        set((s) => (Math.abs(s.playback.currentTime - sec) < 0.05 ? s : { playback: { ...s.playback, currentTime: sec } }));
      },

      togglePlaying() {
        set((s) => ({ playback: { ...s.playback, playing: !s.playback.playing, playAll: s.playback.playing ? false : s.playback.playAll } }));
      },

      startPlayAll() {
        set((s) => ({ playback: { ...s.playback, playing: true, playAll: true } }));
      },

      stopPlayback() {
        set({ playback: { playing: false, playAll: false, currentTime: 0 } });
      },
    };
  });
}

/** The editor's singleton store. */
// One store per page even if the module is loaded twice (a dev-server reload can serve it under two
// URLs; half the editor then read an empty copy). Like lib/unsavedGuard.
const shared = globalThis as typeof globalThis & { __lvsEditorStore?: StoreApi<EditorState> };
export const editorStore = (shared.__lvsEditorStore ??= createEditorStore());

export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(editorStore, selector);
}
