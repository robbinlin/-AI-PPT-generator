import { describe, expect, it } from "vitest";
import { buildTimeline, FADE_SEC } from "./timelineModel";
import { makeDetail } from "../test/fixtures";

describe("buildTimeline with fades", () => {
  it("overlaps pages by the cross-fade, like the rendered video", () => {
    const d = makeDetail(3);
    for (const s of d.scenes) Object.assign(s, { durationSec: 10, tailPauseSec: 0.5, audio: { status: "ready", assetId: "a" }, muted: false });
    const none = buildTimeline(d.scenes, d.slides, d.scripts, undefined, "none");
    const fade = buildTimeline(d.scenes, d.slides, d.scripts, undefined, "fade");
    expect(none.totalSec).toBeCloseTo(31.5);
    expect(fade.totalSec).toBeCloseTo(31.5 - 2 * FADE_SEC);
    expect(fade.blocks[1]!.start).toBeCloseTo(10.5 - FADE_SEC);
  });
});
