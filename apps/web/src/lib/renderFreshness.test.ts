/**
 * The open editor has to notice by itself when the exported video stops (or starts) matching the
 * project: the server works that out, and no event carries it.
 */
import { describe, expect, it } from "vitest";
import type { Asset } from "@lvs/shared";
import { changesRenderInputs, hasExportedVideo, isVideoCurrent } from "./scenes";
import { editorStore } from "../store/editorStore";
import { makeDetail, makeJob, testId } from "../test/fixtures";

function video(projectId: string, inputHash: string): Asset {
  return { id: testId(), projectId, kind: "video", inputHash, createdAt: "2026-10-01T00:00:00.000Z" } as Asset;
}

describe("render freshness", () => {
  it("looks again after anything but a progress tick", () => {
    const d = makeDetail(1);
    const running = makeJob(d.project.id, { status: "running" });
    expect(changesRenderInputs({ kind: "job", job: running })).toBe(false);
    expect(changesRenderInputs({ kind: "job", job: { ...running, status: "queued" } })).toBe(false);
    expect(changesRenderInputs({ kind: "job", job: { ...running, status: "succeeded" } })).toBe(true);
    expect(changesRenderInputs({ kind: "job", job: { ...running, status: "failed" } })).toBe(true);
    expect(changesRenderInputs({ kind: "scene", scene: d.scenes[0]! })).toBe(true);
    expect(changesRenderInputs({ kind: "project", project: d.project })).toBe(true);
  });

  it("only bothers when the project has an exported video", () => {
    const d = makeDetail(1);
    expect(hasExportedVideo(null)).toBe(false);
    expect(hasExportedVideo(d)).toBe(false);
    const v = video(d.project.id, "h1");
    expect(hasExportedVideo({ ...d, assets: { [v.id]: v } })).toBe(true);
    // A page's own avatar clip is not an export.
    const scene = { ...d.scenes[0]!, avatar: { ...d.scenes[0]!.avatar, assetId: v.id } };
    expect(hasExportedVideo({ ...d, scenes: [scene], assets: { [v.id]: v } })).toBe(false);
  });

  it("setRenderHashes flips the export state without touching unsaved text", () => {
    const d = makeDetail(1);
    const v = video(d.project.id, "h1");
    const store = editorStore.getState();
    store.reset();
    store.load({ ...d, assets: { [v.id]: v }, currentRenderHashes: ["old"] });
    const sceneId = d.scenes[0]!.id;
    editorStore.getState().editScript(sceneId, "還沒存的字");
    expect(isVideoCurrent(editorStore.getState().detail!.currentRenderHashes, v)).toBe(false);

    editorStore.getState().setRenderHashes(["h1", "h2"]);
    expect(isVideoCurrent(editorStore.getState().detail!.currentRenderHashes, v)).toBe(true);
    expect(editorStore.getState().drafts[sceneId]).toBe("還沒存的字");

    // The same answer again leaves the object alone, so nothing re-renders.
    const before = editorStore.getState().detail;
    editorStore.getState().setRenderHashes(["h1", "h2"]);
    expect(editorStore.getState().detail).toBe(before);
  });
});
