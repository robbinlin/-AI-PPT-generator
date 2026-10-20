import { describe, expect, it } from "vitest";
import { normalizeReading } from "../src/outline.js";

describe("normalizeReading", () => {
  it("keeps only the first alternative", () => {
    expect(normalizeReading("Two-way ANOVA 或 雙因子變異數分析")).toBe("Two-way ANOVA");
    expect(normalizeReading("吉巴拉 或 G i b a l a")).toBe("吉巴拉");
    expect(normalizeReading("eta squared or effect size")).toBe("eta squared");
  });
  it("rewrites colloquial 趴 as 百分之", () => {
    expect(normalizeReading("九十五趴 信賴區間")).toBe("百分之九十五 信賴區間");
    expect(normalizeReading("95趴")).toBe("百分之95");
  });
  it("leaves plain readings alone", () => {
    expect(normalizeReading(" V O two max ")).toBe("V O two max");
  });
});

import { extractTermCandidates } from "../src/outline.js";
import type { PipelineSlide } from "../src/prompts.js";
describe("extractTermCandidates", () => {
  const slide = (text: string, notes = ""): PipelineSlide => ({
    id: "s", index: 0,
    content: { pageNumber: 1, textBlocks: [], tables: [], images: [], charts: [], plainText: text, notes, hasText: true, needsOcr: false, widthPt: 960, heightPt: 540, renderFidelity: "native" },
  });
  it("finds acronyms, notation, units and names", () => {
    const c = extractTermCandidates([slide("HIIT 與 MICT 對 VO₂max 的影響；F(4, 110) = 6.21, p < .001, η² = .18；單位 mL/kg/min；95% CI", "Gibala 2012 的設計類似")]);
    for (const t of ["HIIT", "MICT", "VO₂max", "mL/kg/min", "95% CI", "Gibala"]) expect(c).toContain(t);
    expect(c.some((t) => t.startsWith("p <"))).toBe(true);
    expect(c.some((t) => t.startsWith("η²"))).toBe(true);
  });
  it("ignores stop words and caps the list", () => {
    const c = extractTermCandidates([slide("The AND of ABC DEF GHI")], 2);
    expect(c).toHaveLength(2);
    expect(c).not.toContain("The");
  });
});

import { normalizeOutline } from "../src/outline.js";
import { ProjectSettings } from "@lvs/shared";
describe("normalizeOutline term spelling", () => {
  it("snaps model terms back to the spelling used on the slides", () => {
    const slides: PipelineSlide[] = [{ id: "a", index: 0, content: { pageNumber: 1, textBlocks: [], tables: [], images: [], charts: [], plainText: "VO₂max 與 HIIT", hasText: true, needsOcr: false, widthPt: 1, heightPt: 1, renderFidelity: "native" } }];
    const out = normalizeOutline(
      { objectives: [], summary: "", sections: [{ title: "x", slideNumbers: [1], keyPoints: [] }], glossary: [{ term: "VOmax", reading: "最大攝氧量", definition: "" }, { term: "hiit", reading: "高強度間歇訓練", definition: "" }], timeAllocation: [{ slideNumber: 1, seconds: 30 }] },
      { slides, settings: ProjectSettings.parse({}) },
    );
    expect(out.glossary.map((g) => g.term)).toEqual(["VO₂max", "HIIT"]);
  });
});
