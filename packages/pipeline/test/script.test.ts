import { describe, expect, it } from "vitest";
import { ProjectSettings, SlideContent } from "@lvs/shared";
import { buildScriptPrompt, restoreTermSpellings } from "../src/script.js";

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

describe("buildScriptPrompt revision request", () => {
  const base = {
    llm: undefined as never,
    slide: {
      id: "00000000-0000-4000-8000-000000000002",
      index: 1,
      content: SlideContent.parse({ pageNumber: 2, title: "平均數", textBlocks: [{ text: "平均數", role: "title" }], plainText: "平均數", widthPt: 960, heightPt: 540, renderFidelity: "native" }),
    },
    outline: { objectives: [], summary: "", sections: [], glossary: [] },
    settings: ProjectSettings.parse({}),
    allocatedSec: 40,
  };

  it("adds nothing without an instruction", () => {
    expect(buildScriptPrompt(base).prompt).not.toContain("修改要求");
  });

  it("puts the user's direction and the current script last, so they win over the default length", () => {
    const { prompt } = buildScriptPrompt({ ...base, instruction: "縮短到 30 秒", currentScript: "原本的講稿。" });
    const rules = prompt.indexOf("## 撰寫規則");
    const request = prompt.indexOf("## 使用者的修改要求");
    expect(request).toBeGreaterThan(rules);
    expect(prompt.slice(request)).toContain("縮短到 30 秒");
    expect(prompt.slice(request)).toContain("原本的講稿。");
  });
});
