import { describe, expect, it } from "vitest";
import { buildCues, rechunkCues } from "../src/subtitles.js";

describe("rechunkCues", () => {
  const text = "今天我們要看高強度間歇訓練對最大攝氧量的影響，以及它和中等強度訓練的差別。好。";
  const cues = buildCues({ subtitleText: text, durationSec: 10, maxCharsPerLine: 14, language: "zh-TW" });

  it("keeps two-line cues whole at the width they were built for", () => {
    const same = rechunkCues(cues, 14);
    expect(same.map((c) => c.text)).toEqual(cues.map((c) => c.text));
  });

  it("splits for a narrower line and keeps the timing span", () => {
    const out = rechunkCues(cues, 8);
    expect(out.length).toBeGreaterThan(cues.length);
    expect(out[0]!.startSec).toBe(cues[0]!.startSec);
    expect(out.at(-1)!.endSec).toBe(cues.at(-1)!.endSec);
    for (const c of out) for (const line of c.text.split("\n")) expect(line.length).toBeLessThanOrEqual(8);
  });

  it("re-wraps lines for a wider line", () => {
    const wide = rechunkCues(cues, 40);
    expect(wide.some((c) => !c.text.includes("\n") && c.text.length > 14)).toBe(true);
  });
});
