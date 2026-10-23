import { describe, expect, it } from "vitest";
import type { Scene, Slide } from "@lvs/shared";
import { buildTimeline, computePeaks, MUTED_SCENE_SEC } from "./timelineModel";

const slide = (id: string, index: number, hidden = false) => ({ id, index, hidden }) as unknown as Slide;
const scene = (id: string, slideId: string, index: number, extra: Partial<Scene> = {}) =>
  ({ id, slideId, index, muted: false, tailPauseSec: 0.5, audio: { status: "ready" }, ...extra }) as unknown as Scene;

describe("buildTimeline", () => {
  it("lays pages end to end with narration + tail, using estimates until audio exists", () => {
    const { blocks, totalSec } = buildTimeline(
      [scene("b", "s2", 1, { audio: { status: "missing" } } as Partial<Scene>), scene("a", "s1", 0, { durationSec: 10 })],
      [slide("s1", 0), slide("s2", 1)],
      { b: { estimatedDurationSec: 7 } as never },
    );
    expect(blocks.map((b) => [b.scene.id, b.start, b.total, b.estimated])).toEqual([
      ["a", 0, 10.5, false],
      ["b", 10.5, 7.5, true],
    ]);
    expect(totalSec).toBe(18);
  });
  it("skips hidden slides and holds muted pages for the hold time plus their tail, as the renderer does", () => {
    const { blocks } = buildTimeline(
      [scene("a", "s1", 0, { durationSec: 4 }), scene("b", "s2", 1, { muted: true, durationSec: 9 }), scene("c", "s3", 2, { durationSec: 2 })],
      [slide("s1", 0), slide("s2", 1), slide("s3", 2, true)],
      {},
    );
    expect(blocks.map((b) => b.scene.id)).toEqual(["a", "b"]);
    expect(blocks[1]).toMatchObject({ narration: MUTED_SCENE_SEC, tail: 0.5, start: 4.5, total: MUTED_SCENE_SEC + 0.5 });
  });
  it("previews a dragged tail pause for one page and shifts the pages after it", () => {
    const { blocks, totalSec } = buildTimeline(
      [scene("a", "s1", 0, { durationSec: 4 }), scene("b", "s2", 1, { durationSec: 2 })],
      [slide("s1", 0), slide("s2", 1)],
      {},
      { sceneId: "a", tail: 6 },
    );
    expect(blocks.map((b) => [b.start, b.total])).toEqual([
      [0, 10],
      [10, 2.5],
    ]);
    expect(totalSec).toBe(12.5);
  });
});

describe("computePeaks", () => {
  it("normalises bucket maxima", () => {
    const s = new Float32Array([0, 0.5, -1, 0.25, 0, 0, 0.1, -0.2]);
    const p = computePeaks(s, 4);
    expect(p.slice(0, 3)).toEqual([0.5, 1, 0]);
    expect(p[3]).toBeCloseTo(0.2);
  });
});
