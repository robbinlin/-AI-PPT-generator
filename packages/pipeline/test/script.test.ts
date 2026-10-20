import { describe, expect, it } from "vitest";
import { restoreTermSpellings } from "../src/script.js";

describe("restoreTermSpellings", () => {
  const glossary = [
    { term: "VO₂max", reading: "V O two max" },
    { term: "ANOVA", reading: "變異數分析" },
    { term: "HIIT", reading: "H I I T" },
  ];
  it("maps spelled-out readings back to the term in the display script", () => {
    expect(restoreTermSpellings("接著我們來看到 V O two max 的定義，以及 H I I T。", glossary)).toBe("接著我們來看到 VO₂max 的定義，以及 HIIT。");
  });
  it("leaves Chinese readings alone (they are valid prose)", () => {
    expect(restoreTermSpellings("我們用變異數分析檢驗。", glossary)).toBe("我們用變異數分析檢驗。");
  });
});
