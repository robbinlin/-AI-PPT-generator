import { describe, expect, it } from "vitest";
import { rebaseRows } from "./OutlinePanel";

describe("rebaseRows", () => {
  it("replays the lecturer's unsaved edits onto a newer glossary without dropping its new terms", () => {
    const base = [{ term: "VO₂max", reading: "V O 2 max" }, { term: "HIIT", reading: "高強度間歇訓練" }, { term: "RPE" }];
    // Edited VO₂max, deleted RPE, added 乳酸.
    const rows = [{ term: "VO₂max", reading: "最大攝氧量" }, { term: "HIIT", reading: "高強度間歇訓練" }, { term: "乳酸", reading: "乳酸" }];
    // Meanwhile a new plan arrived with ANOVA.
    const next = [{ term: "VO₂max", reading: "V O 2 max" }, { term: "HIIT", reading: "高強度間歇訓練" }, { term: "RPE" }, { term: "ANOVA", reading: "變異數分析" }];
    expect(rebaseRows(base, rows, next)).toEqual([
      { term: "VO₂max", reading: "最大攝氧量" },
      { term: "HIIT", reading: "高強度間歇訓練" },
      { term: "ANOVA", reading: "變異數分析" },
      { term: "乳酸", reading: "乳酸" },
    ]);
  });
});
