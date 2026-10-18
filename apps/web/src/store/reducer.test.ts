import { describe, expect, it } from "vitest";
import { applyProjectEvent } from "./reducer";
import { createEditorStore, currentScript } from "./editorStore";
import { makeDetail, makeJob, makeRevision, testId } from "../test/fixtures";

describe("applyProjectEvent", () => {
  it("tracks active jobs and drops them when they finish", () => {
    const detail = makeDetail();
    const job = makeJob(detail.project.id);
    const running = applyProjectEvent(detail, { kind: "job", job });
    expect(running.activeJobs).toEqual([job]);

    const progressed = applyProjectEvent(running, { kind: "job", job: { ...job, progress: 0.8 } });
    expect(progressed.activeJobs).toHaveLength(1);
    expect(progressed.activeJobs[0]?.progress).toBe(0.8);

    const done = applyProjectEvent(progressed, { kind: "job", job: { ...job, status: "succeeded", progress: 1 } });
    expect(done.activeJobs).toEqual([]);
  });

  it("follows the parse job onto the source document (there is no source event)", () => {
    const detail = makeDetail();
    const sourceId = testId();
    detail.sourceDocument = {
      id: sourceId,
      projectId: detail.project.id,
      filename: "deck.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      storageKey: "k",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      version: 1,
      parseStatus: "queued",
      createdAt: detail.project.createdAt,
    };
    const job = makeJob(detail.project.id, {
      type: "parse_document",
      payload: { type: "parse_document", sourceDocumentId: sourceId },
    });
    const next = applyProjectEvent(detail, { kind: "job", job: { ...job, status: "failed", error: "bad pdf" } });
    expect(next.sourceDocument?.parseStatus).toBe("failed");
    expect(next.sourceDocument?.parseJobId).toBe(job.id);
  });

  it("replaces a scene and recomputes the total duration", () => {
    const detail = makeDetail();
    const scene = detail.scenes[1];
    if (!scene) throw new Error("fixture");
    const next = applyProjectEvent(detail, {
      kind: "scene",
      scene: { ...scene, audio: { status: "ready", assetId: testId() }, durationSec: 4 },
    });
    expect(next.scenes[1]?.audio.status).toBe("ready");
    expect(next.totalDurationSec).toBe(10 + 0.5 + 4 + 0.5);
    expect(next.scenes.map((s) => s.id)).toEqual(detail.scenes.map((s) => s.id));
  });

  it("excludes hidden slides from the total duration", () => {
    const detail = makeDetail();
    const slides = detail.slides.map((s, i) => (i === 0 ? { ...s, hidden: true } : s));
    const next = applyProjectEvent(detail, { kind: "slides", slides, scenes: detail.scenes });
    expect(next.totalDurationSec).toBe(0);
  });

  it("keeps the newest script revision", () => {
    const detail = makeDetail();
    const sceneId = detail.scenes[0]?.id ?? "";
    const v2 = makeRevision(sceneId, "v2", 2);
    const withV2 = applyProjectEvent(detail, { kind: "script", script: v2 });
    expect(withV2.scripts[sceneId]?.script).toBe("v2");
    const stale = applyProjectEvent(withV2, { kind: "script", script: makeRevision(sceneId, "old", 1) });
    expect(stale.scripts[sceneId]?.script).toBe("v2");
  });

  it("ignores scripts for unknown scenes and events for other projects", () => {
    const detail = makeDetail();
    expect(applyProjectEvent(detail, { kind: "script", script: makeRevision(testId(), "x") })).toBe(detail);
    const other = { ...detail.project, id: testId(), name: "Other" };
    expect(applyProjectEvent(detail, { kind: "project", project: other })).toBe(detail);
    const job = makeJob(testId());
    expect(applyProjectEvent(detail, { kind: "job", job })).toBe(detail);
  });

  it("applies assets, outline and project updates", () => {
    const detail = makeDetail();
    const assetId = testId();
    const withAsset = applyProjectEvent(detail, {
      kind: "asset",
      asset: {
        id: assetId,
        projectId: detail.project.id,
        kind: "video",
        storageKey: "k",
        mimeType: "video/mp4",
        sizeBytes: 10,
        producedBy: {},
        createdAt: detail.project.createdAt,
      },
    });
    expect(withAsset.assets[assetId]?.kind).toBe("video");

    const outline = {
      id: testId(),
      projectId: detail.project.id,
      version: 1,
      objectives: ["a"],
      summary: "",
      sections: [],
      glossary: [],
      timeAllocation: {},
      inputHash: "h",
      createdAt: detail.project.createdAt,
    };
    expect(applyProjectEvent(withAsset, { kind: "outline", outline }).outline?.objectives).toEqual(["a"]);

    const renamed = applyProjectEvent(detail, { kind: "project", project: { ...detail.project, name: "Renamed" } });
    expect(renamed.project.name).toBe("Renamed");
  });

  it("reorders slides and scenes from a slides event", () => {
    const detail = makeDetail();
    const [a, b, c] = detail.slides;
    if (!a || !b || !c) throw new Error("fixture");
    const order = [c.id, a.id, b.id];
    const slides = detail.slides.map((s) => ({ ...s, index: order.indexOf(s.id) }));
    const scenes = detail.scenes.map((s) => ({ ...s, index: order.indexOf(s.slideId) }));
    const next = applyProjectEvent(detail, { kind: "slides", slides, scenes });
    expect(next.slides.map((s) => s.id)).toEqual(order);
    expect(next.scenes.map((s) => s.slideId)).toEqual(order);
  });
});

describe("editor store", () => {
  function setup() {
    const store = createEditorStore();
    const detail = makeDetail();
    store.getState().load(detail);
    const sceneId = detail.scenes[0]?.id ?? "";
    return { store, detail, sceneId };
  }

  it("selects the first scene on load and moves with selectRelative", () => {
    const { store, detail } = setup();
    expect(store.getState().selectedSceneId).toBe(detail.scenes[0]?.id);
    store.getState().selectRelative(1);
    expect(store.getState().selectedSceneId).toBe(detail.scenes[1]?.id);
    store.getState().selectRelative(10);
    expect(store.getState().selectedSceneId).toBe(detail.scenes[2]?.id);
    store.getState().selectRelative(-10);
    expect(store.getState().selectedSceneId).toBe(detail.scenes[0]?.id);
  });

  it("keeps optimistic edits as drafts, with undo/redo and a dirty flag", () => {
    const { store, sceneId } = setup();
    const s = () => store.getState();
    s().editScript(sceneId, "第一頁講稿！");
    s().editScript(sceneId, "第一頁講稿！！");
    expect(currentScript(s(), sceneId)).toBe("第一頁講稿！！");
    expect(s().dirty).toBe(true);

    s().undo(sceneId);
    expect(currentScript(s(), sceneId)).toBe("第一頁講稿！");
    s().undo(sceneId);
    // Back to the saved text: no draft, not dirty.
    expect(currentScript(s(), sceneId)).toBe("第一頁講稿");
    expect(s().drafts[sceneId]).toBeUndefined();
    expect(s().dirty).toBe(false);

    s().redo(sceneId);
    expect(currentScript(s(), sceneId)).toBe("第一頁講稿！");
    expect(s().dirty).toBe(true);
    // A new edit clears the redo stack.
    s().editScript(sceneId, "new");
    s().redo(sceneId);
    expect(currentScript(s(), sceneId)).toBe("new");
  });

  it("clears the draft once the saved revision matches it", () => {
    const { store, sceneId } = setup();
    store.getState().editScript(sceneId, "edited");
    store.getState().markSaving(sceneId);
    store.getState().markSaved(sceneId, makeRevision(sceneId, "edited", 2, "user"), "edited");
    expect(store.getState().drafts[sceneId]).toBeUndefined();
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().saveState[sceneId]?.status).toBe("saved");
    expect(store.getState().detail?.scripts[sceneId]?.version).toBe(2);
  });

  it("keeps a newer draft when an older save completes", () => {
    const { store, sceneId } = setup();
    store.getState().editScript(sceneId, "a");
    store.getState().editScript(sceneId, "ab");
    store.getState().markSaved(sceneId, makeRevision(sceneId, "a", 2, "user"), "a");
    expect(store.getState().drafts[sceneId]).toBe("ab");
    expect(store.getState().dirty).toBe(true);
  });

  it("lets an AI rewrite replace the text but keeps it undoable", () => {
    const { store, sceneId } = setup();
    store.getState().applyEvent({ kind: "script", script: makeRevision(sceneId, "AI 新講稿", 2, "ai") });
    expect(currentScript(store.getState(), sceneId)).toBe("AI 新講稿");
    store.getState().undo(sceneId);
    expect(currentScript(store.getState(), sceneId)).toBe("第一頁講稿");
    expect(store.getState().dirty).toBe(true);
  });

  it("remembers finished jobs for the jobs drawer", () => {
    const { store, detail } = setup();
    const job = makeJob(detail.project.id);
    store.getState().applyEvent({ kind: "job", job });
    expect(store.getState().recentJobs).toEqual([]);
    store.getState().applyEvent({ kind: "job", job: { ...job, status: "succeeded", progress: 1 } });
    expect(store.getState().recentJobs.map((j) => j.status)).toEqual(["succeeded"]);
    expect(store.getState().detail?.activeJobs).toEqual([]);
  });

  it("advances play-all to the next scene with audio, skipping muted ones", () => {
    const { store, detail } = setup();
    const [first, second, third] = detail.scenes;
    if (!first || !second || !third) throw new Error("fixture");
    store.getState().upsertScene({ ...second, muted: true, audio: { status: "ready", assetId: testId() } });
    store.getState().upsertScene({ ...third, audio: { status: "ready", assetId: testId() } });
    store.getState().select(first.id);
    expect(store.getState().advanceToNextPlayable()).toBe(true);
    expect(store.getState().selectedSceneId).toBe(third.id);
    expect(store.getState().advanceToNextPlayable()).toBe(false);
  });
});
