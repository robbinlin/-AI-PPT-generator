import { describe, expect, it } from "vitest";
import { rechunkCues } from "../src/subtitles.js";

describe("rechunkCues", () => {
  it("splits long cues for a narrower line and keeps the timing span", () => {
    const cues = [
      { index: 1, startSec: 0, endSec: 4, text: "今天我們要看高強度間歇訓練對最大攝氧量的影響，以及它和中等強度訓練的差別。" },
      { index: 2, startSec: 4, endSec: 5, text: "好。" },
    ];
    const out = rechunkCues(cues, 12);
    expect(out.length).toBeGreaterThan(2);
    expect(out[0]!.startSec).toBe(0);
    expect(out.at(-2)!.endSec).toBeCloseTo(4);
    expect(out.at(-1)).toMatchObject({ startSec: 4, endSec: 5, text: "好。" });
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i + 1));
    for (let i = 1; i < out.length; i++) expect(out[i]!.startSec).toBeGreaterThanOrEqual(out[i - 1]!.startSec);
  });
});
