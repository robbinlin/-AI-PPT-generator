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
