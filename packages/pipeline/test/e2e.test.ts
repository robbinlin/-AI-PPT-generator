import { describe, expect, it } from "vitest";
import { ProjectSettings, SlideContent, type OutlineRevision } from "@lvs/shared";
import { MockLlmProvider, MockTtsProvider } from "@lvs/providers";
import { buildOutlinePrompt, defaultTimeAllocation, generateOutline, normalizeOutline, type OutlineLlmOutput } from "../src/outline.js";
import { buildScriptPrompt, finalizeScriptTexts, generateSceneScript } from "../src/script.js";
import { buildCues, cuesToAss, cuesToSrt } from "../src/subtitles.js";
import { audioInputHash } from "../src/hashes.js";
import type { PipelineSlide } from "../src/prompts.js";

function slide(index: number, title: string, body: string[], notes?: string): PipelineSlide {
  const content = SlideContent.parse({
    pageNumber: index + 1,
    title,
    textBlocks: [{ text: title, role: "title" }, ...body.map((t) => ({ text: t, role: "bullet" }))],
    notes,
    plainText: [title, ...body].join("\n"),
    widthPt: 960,
    heightPt: 540,
    renderFidelity: "native",
  });
  return { id: `00000000-0000-4000-8000-00000000000${index + 1}`, index, content };
}

const slides = [
  slide(0, "運動生理學導論", ["VO₂max 的定義", "為何重要"], "開場：介紹本週主題"),
  slide(1, "研究設計", ["隨機分派 n = 40", "ANOVA 分析，p < .05 視為顯著"]),
  slide(2, "結果與結論", ["介入組提升 12.5%", "Smith 等人 (2020) 的結果一致"]),
];

const outlineAnswer: OutlineLlmOutput = {
  objectives: ["說明 VO₂max", "理解研究設計"],
  summary: "本教材介紹最大攝氧量與其研究。",
  sections: [
    { title: "導論", slideNumbers: [1], keyPoints: ["定義"] },
    { title: "研究", slideNumbers: [2, 3], keyPoints: ["設計", "結果"] },
  ],
  glossary: [
    { term: "VO₂max", reading: "V O two max", definition: "最大攝氧量" },
    { term: "ANOVA", reading: "變異數分析", definition: "" },
    { term: "Smith", reading: "史密斯", definition: "" },
  ],
  timeAllocation: [
    { slideNumber: 1, seconds: 30 },
    { slideNumber: 2, seconds: 60 },
    { slideNumber: 3, seconds: 45 },
  ],
};

describe("outline", () => {
  it("prompt is Traditional Chinese for zh-TW and English otherwise", () => {
    const zh = buildOutlinePrompt({ llm: new MockLlmProvider(() => ({})), slides, settings: ProjectSettings.parse({}) });
    expect(zh.system).toMatch(/教學設計師/);
    expect(zh.prompt).toContain("### Slide 2 (page 2)");
    expect(zh.prompt).toContain("Speaker notes: 開場");
    const en = buildOutlinePrompt({ llm: new MockLlmProvider(() => ({})), slides, settings: ProjectSettings.parse({ language: "en", targetDurationSec: 300 }) });
    expect(en.system).toMatch(/instructional designer/);
    expect(en.prompt).toContain("sum to exactly 300");
  });
  it("normalizes coverage, glossary and time sums", () => {
    const settings = ProjectSettings.parse({ targetDurationSec: 300 });
    const partial: OutlineLlmOutput = { ...outlineAnswer, sections: [{ title: "只有一頁", slideNumbers: [2, 99], keyPoints: [] }], timeAllocation: [] };
    const o = normalizeOutline(partial, { slides, settings, glossarySeed: [{ term: "CI", reading: "信賴區間" }] });
    expect(o.sections.map((s) => s.slideIds.length)).toEqual([1, 2]); // "其他" covers slides 1 and 3
    expect(o.sections[1]!.title).toBe("其他");
    expect(Object.values(o.timeAllocation).reduce((a, b) => a + b, 0)).toBe(300);
    expect(o.glossary.map((g) => g.term)).toEqual(["VO₂max", "ANOVA", "Smith", "CI"]);
    expect(o.inputHash).toHaveLength(64);
  });
  it("clamps per-slide seconds without a target", () => {
    const o = normalizeOutline({ ...outlineAnswer, timeAllocation: [{ slideNumber: 1, seconds: 5 }, { slideNumber: 2, seconds: 500 }] }, { slides, settings: ProjectSettings.parse({}) });
    expect(o.timeAllocation[slides[0]!.id]).toBe(15);
    expect(o.timeAllocation[slides[1]!.id]).toBe(90);
    // slide 3 had no model allocation: density fallback, still clamped
    expect(o.timeAllocation[slides[2]!.id]).toBeGreaterThanOrEqual(15);
    expect(o.timeAllocation[slides[2]!.id]).toBeLessThanOrEqual(90);
  });
  it("defaultTimeAllocation scales to the target", () => {
    const a = defaultTimeAllocation(slides, 120);
    expect(Object.values(a).reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(118);
  });
});

describe("script", () => {
  const settings = ProjectSettings.parse({});
  const outline = normalizeOutline(outlineAnswer, { slides, settings });
  it("prompt rules differ for first/middle/last slides and boundaries", () => {
    const first = buildScriptPrompt({ llm: new MockLlmProvider(() => ({})), slide: slides[0]!, nextSlide: slides[1], outline, settings, allocatedSec: 30 });
    expect(first.prompt).toMatch(/第一頁：可以用一兩句話開場/);
    expect(first.prompt).toContain("約 135 個中文字");
    const mid = buildScriptPrompt({ llm: new MockLlmProvider(() => ({})), slide: slides[1]!, prevSlide: slides[0], nextSlide: slides[2], outline, settings: { ...settings, contentBoundary: "allow_external" }, allocatedSec: 60 });
    expect(mid.prompt).toMatch(/不要再次打招呼/);
    expect(mid.prompt).toMatch(/「補充：」開頭/);
    expect(mid.prompt).toContain("上一頁：Slide 1");
    expect(mid.prompt).toContain("讀法：V O two max");
  });
  it("finalizeScriptTexts fills blanks deterministically", () => {
    const r = finalizeScriptTexts({ script: "  VO₂max 在 p < .05 下提升 12.5%。 ", pronunciationText: "", subtitleText: "", estimatedDurationSec: 0 }, { outline, settings });
    expect(r.script).toBe("VO₂max 在 p < .05 下提升 12.5%。");
    expect(r.pronunciationText).toBe("V O two max 在 p 小於 零點零五 下提升 百分之十二點五。");
    expect(r.subtitleText).toBe("VO₂max 在 p < .05 下提升 12.5%。");
    expect(r.estimatedDurationSec).toBeGreaterThan(0);
    expect(() => finalizeScriptTexts({ script: " ", pronunciationText: "", subtitleText: "", estimatedDurationSec: 1 }, { outline, settings })).toThrow();
  });
});

describe("end to end (mock providers, no network)", () => {
  it("outline → 3 scripts → tts → cues → srt/ass", async () => {
    const settings = ProjectSettings.parse({ targetDurationSec: 120 });
    const llm = new MockLlmProvider(({ prompt }) => {
      if (prompt.includes("## 規劃要求")) return outlineAnswer;
      const m = /### Slide (\d+)/.exec(prompt.split("## 本頁內容")[1] ?? "");
      const n = Number(m?.[1] ?? 1);
      const base = slides[n - 1]!.content.plainText.replace(/\n/g, "，");
      return { script: `${n === 1 ? "大家好，" : ""}這一頁講${base}。p < .05 代表顯著。`, pronunciationText: "", subtitleText: "", estimatedDurationSec: 20 };
    });
    const { outline, usage } = await generateOutline({ llm, slides, settings });
    expect(usage.find((u) => u.unit === "tokens_in")!.quantity).toBeGreaterThan(0);
    expect(Object.values(outline.timeAllocation).reduce((a, b) => a + b, 0)).toBe(120);
    const full: OutlineRevision = { ...outline, id: "00000000-0000-4000-8000-0000000000aa", projectId: "00000000-0000-4000-8000-0000000000bb", version: 1, createdAt: new Date().toISOString() };

    const tts = new MockTtsProvider();
    const previous: string[] = [];
    const results = [];
    for (let i = 0; i < slides.length; i++) {
      const s = await generateSceneScript({
        llm,
        slide: slides[i]!,
        prevSlide: slides[i - 1],
        nextSlide: slides[i + 1],
        outline: full,
        settings,
        allocatedSec: full.timeAllocation[slides[i]!.id]!,
        previousScripts: previous,
      });
      previous.push(s.script);
      expect(s.pronunciationText).toContain("p 小於 零點零五");
      expect(s.pronunciationText).not.toContain("<");
      expect(s.subtitleText).toContain("p < .05");
      if (i === 1) expect(s.pronunciationText).toContain("變異數分析");
      if (i === 2) expect(s.pronunciationText).toContain("史密斯");

      const audio = await tts.synthesize({ text: s.pronunciationText, voiceId: "mock-zh-f", language: settings.language, speed: settings.voice.speed });
      const hash = audioInputHash({ pronunciationText: s.pronunciationText, voice: settings.voice, glossary: full.glossary, language: settings.language });
      expect(hash).toHaveLength(64);
      const cues = buildCues({
        subtitleText: s.subtitleText,
        timestamps: audio.data.timestamps,
        durationSec: audio.data.durationSec,
        maxCharsPerLine: settings.subtitles.style.maxCharsPerLine,
        language: settings.language,
      });
      expect(cues.length).toBeGreaterThan(0);
      expect(cues.at(-1)!.endSec).toBeLessThanOrEqual(audio.data.durationSec + 1e-6);
      results.push({ script: s, audio: audio.data, cues });
    }
    expect(llm.calls).toHaveLength(4);
    expect(results[0]!.script.script.startsWith("大家好")).toBe(true);
    expect(results[1]!.script.script.startsWith("大家好")).toBe(false);

    const srt = cuesToSrt(results[1]!.cues);
    expect(srt.split("\n\n").length).toBe(results[1]!.cues.length);
    const ass = cuesToAss(results[1]!.cues, settings.subtitles.style, 1920, 1080);
    expect(ass.match(/^Dialogue:/gm)?.length).toBe(results[1]!.cues.length);
    expect(ass).toContain("p < .05");
  });
});
