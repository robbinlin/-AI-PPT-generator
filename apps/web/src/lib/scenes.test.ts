import { describe, expect, it } from "vitest";
import { firstSubtitleCue } from "./scenes";

describe("firstSubtitleCue", () => {
  it("never breaks an English word across lines", () => {
    const cue = firstSubtitleCue("Next, let us look at the definition of VO₂max. Maximum oxygen uptake is…", 28);
    const lines = cue.split("\n");
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const word of ["definition", "VO₂max"]) expect(lines.some((l) => l.includes(word)) || !cue.includes(word.slice(0, 3))).toBe(true);
    expect(cue).not.toMatch(/def\ninition/);
    expect(cue).not.toContain("Maximum"); // only the first sentence
  });

  it("wraps Chinese by character count and marks a cut-off second line", () => {
    const cue = firstSubtitleCue("一二三四五六七八九十一二三四五六七八九十一二三四五。", 10);
    expect(cue.split("\n")).toEqual(["一二三四五六七八九十", "一二三四五六七八九十…"]);
  });

  it("keeps a short sentence on one line", () => {
    expect(firstSubtitleCue("大家好。今天上課。", 28)).toBe("大家好");
  });
});
