import { describe, expect, it } from "vitest";
import { applyGlossaryReadings, isTranslationNotReading, usesGlossaryTerm } from "./glossary.js";

describe("glossary matching", () => {
  it("does not change a term inside a hyphenated word or after a bracket", () => {
    const g = [
      { term: "Two", reading: "兔" },
      { term: "O₂", reading: "氧" },
    ];
    expect(applyGlossaryReadings("Two-way 變異數分析", g)).toBe("Two-way 變異數分析");
    expect(applyGlossaryReadings("(a-v)O₂ diff", g)).toBe("(a-v)O₂ diff");
    expect(applyGlossaryReadings("呼吸的 O₂ 濃度", g)).toBe("呼吸的 氧 濃度");
  });

  it("knows which scripts use a term", () => {
    expect(usesGlossaryTerm("one-way ANOVA", "ANOVA")).toBe(true);
    expect(usesGlossaryTerm("ANOVAs", "ANOVA")).toBe(false);
    expect(usesGlossaryTerm("VO₂max 與 VO₂", "VO")).toBe(false);
    expect(usesGlossaryTerm("VO₂max", "VO₂max")).toBe(true);
    expect(usesGlossaryTerm("最大攝氧量", "攝氧")).toBe(true);
  });

  it("treats words, paths and number words with Chinese 'readings' as translations, names not", () => {
    expect(isTranslationNotReading("org/mrsc", "網址路徑")).toBe(true);
    expect(isTranslationNotReading("Two", "二")).toBe(true);
    expect(isTranslationNotReading("mean", "平均數")).toBe(true);
    expect(isTranslationNotReading("Smith", "史密斯")).toBe(false);
    expect(isTranslationNotReading("ANOVA", "變異數分析")).toBe(false);
  });
});
