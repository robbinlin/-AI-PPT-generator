import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "@lvs/providers";
import { buildTranslatePrompt, inTargetLanguage, TRANSLATION_PROMPT_HEADING, translateSceneScript } from "../src/translate.js";

describe("translateSceneScript", () => {
  it("builds a prompt with the page, its neighbours as context only, and the glossary", () => {
    const { system, prompt } = buildTranslatePrompt({
      script: "今天我們談最大攝氧量。",
      from: "zh-TW",
      to: "en",
      pageNumber: 2,
      pageCount: 5,
      title: "運動生理學",
      previousScript: "上一頁的內容。",
      nextScript: "下一頁的內容。",
      glossary: [{ term: "VO₂max", reading: "V O two max", definition: "最大攝氧量" }],
    });
    expect(system).toContain("into English");
    expect(system).toContain("spoken");
    expect(prompt).toContain("Page 2 of 5.");
    expect(prompt).toContain("- VO₂max: 最大攝氧量");
    expect(prompt).toContain("(context only, do not translate)\n上一頁的內容。");
    expect(prompt.endsWith(`${TRANSLATION_PROMPT_HEADING}\n今天我們談最大攝氧量。`)).toBe(true);
  });

  it("returns English texts: pronunciation without source-language readings, an English duration", async () => {
    const llm = new MockLlmProvider(() => ({ script: "  Today we look at VO2max, about 3.5 litres a minute.  " }));
    const out = await translateSceneScript({ llm, script: "今天看最大攝氧量。", from: "zh-TW", to: "en", pageNumber: 1, pageCount: 1 });
    expect(out.script).toBe("Today we look at VO2max, about 3.5 litres a minute.");
    expect(out.subtitleText).toBe(out.script);
    expect(out.pronunciationText).not.toMatch(/[一-鿿]/); // English number reading, no Chinese
    expect(out.estimatedDurationSec).toBeGreaterThan(2);
    expect(out.estimatedDurationSec).toBeLessThan(8);
  });

  it("rejects an empty translation", async () => {
    const llm = new MockLlmProvider(() => ({ script: "   " }));
    await expect(translateSceneScript({ llm, script: "x", from: "zh-TW", to: "en", pageNumber: 1, pageCount: 1 })).rejects.toThrow(/empty/);
  });

  it("asks again when the model echoes the source, and fails if it keeps doing so", async () => {
    let calls = 0;
    const llm = new MockLlmProvider(() => ({ script: ++calls === 1 ? "接著來看獨立性檢定的判斷標準，若 p 值小於 α 則拒絕。" : "Next, the decision rule of the test of independence." }));
    const out = await translateSceneScript({ llm, script: "接著來看獨立性檢定的判斷標準。", from: "zh-TW", to: "en", pageNumber: 9, pageCount: 18 });
    expect(calls).toBe(2);
    expect(out.script).toBe("Next, the decision rule of the test of independence.");
    const stuck = new MockLlmProvider(() => ({ script: "接著來看獨立性檢定的判斷標準。" }));
    await expect(translateSceneScript({ llm: stuck, script: "接著來看。", from: "zh-TW", to: "en", pageNumber: 1, pageCount: 1 })).rejects.toThrow(/untranslated/);
    expect(inTargetLanguage("虛無假設 H0 為 PPHN 新生兒死亡與懷孕周數無關", "en")).toBe(false);
    expect(inTargetLanguage("PPHN means 新生兒持續性肺動脈高壓 in Chinese, and we test H0 against Ha today.", "en")).toBe(true);
  });
});
