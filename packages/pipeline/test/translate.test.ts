import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "@lvs/providers";
import { buildTranslatePrompt, TRANSLATION_PROMPT_HEADING, translateSceneScript } from "../src/translate.js";

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
});
