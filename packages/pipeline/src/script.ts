import { z } from "zod";
import type { LlmAttachment, LlmProvider, ProjectSettings, UsageDelta, GlossaryEntry } from "@lvs/shared";
import type { OutlineDraft } from "./outline.js";
import { describeAudience, describeLanguage, describeMode, isZh, renderGlossary, renderSlideContent, slideBrief, type PipelineSlide } from "./prompts.js";
import { delatex, derivePronunciationText, deriveSubtitleText, estimateSpeakingSeconds, targetLength } from "./texts.js";

export const ScriptLlmOutput = z.object({
  script: z.string(),
  pronunciationText: z.string(),
  subtitleText: z.string(),
  estimatedDurationSec: z.number().min(0),
});
export type ScriptLlmOutput = z.infer<typeof ScriptLlmOutput>;

export interface GenerateSceneScriptInput {
  llm: LlmProvider;
  slide: PipelineSlide;
  prevSlide?: PipelineSlide;
  nextSlide?: PipelineSlide;
  outline: Pick<OutlineDraft, "objectives" | "summary" | "sections" | "glossary">;
  settings: ProjectSettings;
  allocatedSec: number;
  /** Scripts already written for earlier slides (last 1–2), to keep tone and avoid repetition. */
  previousScripts?: string[];
  attachImage?: boolean;
  /** A rewrite with a direction: revise `currentScript` as asked instead of writing from scratch. */
  instruction?: string;
  currentScript?: string;
}

export interface GenerateSceneScriptResult {
  script: string;
  pronunciationText: string;
  subtitleText: string;
  estimatedDurationSec: number;
  usage: UsageDelta[];
}

export function buildScriptPrompt(input: GenerateSceneScriptInput): { system: string; prompt: string } {
  const { settings, slide, outline } = input;
  const zh = isZh(settings);
  const isFirst = slide.index === 0;
  const isLast = !input.nextSlide;
  const section = outline.sections.find((s) => s.slideIds.includes(slide.id));
  const len = targetLength(input.allocatedSec, settings.language);
  const lengthText = zh
    ? `約 ${len.chars} 個中文字（對應 ${input.allocatedSec} 秒，允許正負 15%）`
    : `about ${len.words} words (${input.allocatedSec} seconds, ±15%)`;

  const system = zh
    ? `你是一位${describeAudience(settings)}的課程講師，正在為一支投影片解說影片撰寫「單一頁」的口語講稿。
整份影片的規劃（目標、章節、術語表）已經完成，你只負責這一頁，並讓它與前後頁自然銜接。
你必須同時產出三份文字：
1. script：給使用者閱讀與編輯的講稿，口語、自然、可直接朗讀。術語一律用原本的寫法（VO₂max、ANOVA、η²），絕對不要把術語表的「讀法」寫進 script。
2. pronunciationText：給語音合成引擎朗讀的版本，將術語依術語表讀法展開、統計符號與小數改為口語（例如 p < .05 → p 小於 零點零五、25% → 百分之二十五），其餘內容與 script 完全相同。
3. subtitleText：給畫面字幕的版本，保留正式拼寫與符號（VO₂max、p < .05），與 script 相同。
語言：${describeLanguage(settings)}。`
    : `You are a lecturer for ${describeAudience(settings)} writing the spoken script for ONE slide of a narrated slide video.
The deck-level plan (objectives, sections, glossary) is done; you only write this slide, connecting it naturally to its neighbours.
Produce three texts:
1. script: what the user reads and edits — conversational, natural, ready to read aloud.
2. pronunciationText: the same content prepared for a text-to-speech engine — expand glossary readings, speak symbols and decimals (p < .05 → p less than point zero five, 25% → twenty-five percent).
3. subtitleText: the on-screen version — formal spelling and symbols kept (VO₂max, p < .05), same content as script without filler words.
Language: ${describeLanguage(settings)}.`;

  const rules = zh
    ? [
        isFirst ? "這是第一頁：可以用一兩句話開場並說明本次主題。" : "這不是第一頁：不要再次打招呼或自我介紹，直接承接上一頁的內容。",
        isLast ? "這是最後一頁：以一兩句話收束整份內容。" : "不是最後一頁：結尾可用一句話自然帶到下一頁，但不要預告下一頁的細節。",
        "術語表中的術語若已在前面頁面定義過，不要重新定義，直接使用。",
        // Seen on 2026-10-26: the slide said 連續變項／類別變項 and the script said 連續變異數／類別變異數.
        "投影片上的專有名詞照投影片的寫法說，不可換成意思不同的近似詞。特別注意：變項（variable，例如連續變項、類別變項）與變異數（variance）是不同概念，不可混用。",
        // Seen on 2026-10-27: 「$R \times C$」「$N_{ij}$」 in a script, shown verbatim in the subtitles.
        "公式不要用 LaTeX 或 $ 符號，直接用一般文字與符號寫（例如 R × C、Nij、χ²）。",
        settings.contentBoundary === "source_only"
          ? "只能講投影片與備忘稿有的內容；不可補充未出現的數據、文獻、年份或作者。"
          : "可以補充投影片以外的背景或例子，但補充的句子必須以「補充：」開頭。",
        `模式：${describeMode(settings)}。`,
        `長度：${lengthText}。`,
        settings.styleNote ? `風格：${settings.styleNote}` : "",
        "不要輸出標題、項目符號或 Markdown；講稿是連續的口語段落。",
        "estimatedDurationSec 填寫你估計的朗讀秒數。",
      ]
    : [
        isFirst ? "This is the first slide: open with one or two sentences introducing the topic." : "This is not the first slide: do not greet or re-introduce; continue from the previous slide.",
        isLast ? "This is the last slide: close the lecture in one or two sentences." : "Not the last slide: you may bridge to the next slide in one sentence without previewing its details.",
        "Do not re-define glossary terms already defined on earlier slides; just use them.",
        settings.contentBoundary === "source_only"
          ? "Use only what the slide and speaker notes contain; never add numbers, citations, years or authors that are not there."
          : "You may add background or examples beyond the slide, but every such sentence must start with 'Supplement:'.",
        `Mode: ${describeMode(settings)}.`,
        `Length: ${lengthText}.`,
        settings.styleNote ? `Style: ${settings.styleNote}` : "",
        "No headings, bullets or Markdown; the script is continuous spoken prose.",
        "estimatedDurationSec is your estimate of the spoken duration in seconds.",
      ];

  const prompt = [
    zh ? "## 全篇規劃" : "## Deck plan",
    (zh ? "摘要：" : "Summary: ") + outline.summary,
    (zh ? "學習目標：" : "Objectives: ") + outline.objectives.join("；"),
    section ? (zh ? `本頁所屬章節：${section.title}｜重點：${section.keyPoints.join("；")}` : `Section: ${section.title} | key points: ${section.keyPoints.join("; ")}`) : "",
    "",
    zh ? "## 術語表（讀法用於 pronunciationText）" : "## Glossary (readings are for pronunciationText)",
    renderGlossary(outline.glossary, zh),
    "",
    zh ? "## 前後頁" : "## Neighbouring slides",
    input.prevSlide ? (zh ? "上一頁：" : "Previous: ") + slideBrief(input.prevSlide) : zh ? "上一頁：（無）" : "Previous: (none)",
    input.nextSlide ? (zh ? "下一頁：" : "Next: ") + slideBrief(input.nextSlide) : zh ? "下一頁：（無）" : "Next: (none)",
    input.previousScripts?.length ? (zh ? "\n## 前一頁的講稿（避免重複、保持語氣）\n" : "\n## Previous slide's script (avoid repeating, keep the tone)\n") + input.previousScripts.at(-1) : "",
    "",
    zh ? "## 本頁內容" : "## This slide",
    renderSlideContent(slide),
    "",
    zh ? "## 撰寫規則" : "## Rules",
    ...rules.filter(Boolean).map((r) => `- ${r}`),
    ...revisionRequest(input, zh),
  ].join("\n");

  return { system, prompt };
}

/**
 * The user's direction for 「AI 重寫本頁」. It comes last so it wins over the default length and
 * style rules (e.g. 「縮短到 30 秒」), while the content boundary above still applies.
 */
function revisionRequest(input: GenerateSceneScriptInput, zh: boolean): string[] {
  const instruction = input.instruction?.trim();
  if (!instruction) return [];
  const current = input.currentScript?.trim();
  return zh
    ? [
        "",
        "## 使用者的修改要求（優先於上面的長度與風格規則）",
        instruction,
        ...(current ? ["", "## 目前的講稿（依要求改寫，沒被要求改的內容盡量保留）", current] : []),
      ]
    : [
        "",
        "## The user's revision request (overrides the length and style rules above)",
        instruction,
        ...(current ? ["", "## Current script (revise it as asked; keep what the request does not touch)", current] : []),
      ];
}

export async function generateSceneScript(input: GenerateSceneScriptInput): Promise<GenerateSceneScriptResult> {
  const { system, prompt } = buildScriptPrompt(input);
  const attachments: LlmAttachment[] =
    (input.attachImage ?? true) && input.slide.imagePng
      ? [{ mimeType: "image/png", data: input.slide.imagePng, label: `Slide ${input.slide.index + 1} image` }]
      : [];
  const res = await input.llm.generateJson({
    system,
    prompt,
    schema: ScriptLlmOutput,
    ...(attachments.length ? { attachments } : {}),
    temperature: 0.5,
    reasoning: "none",
  });
  const finished = finalizeScriptTexts(res.data, input);
  return { ...finished, usage: res.usage };
}

/**
 * Safety net: fill blanks and normalise the three texts deterministically so
 * downstream hashes do not depend on model whitespace quirks.
 */
export function finalizeScriptTexts(
  raw: ScriptLlmOutput,
  input: Pick<GenerateSceneScriptInput, "outline" | "settings">,
): Omit<GenerateSceneScriptResult, "usage"> {
  const glossary = input.outline.glossary;
  const script = restoreTermSpellings(delatex(raw.script.replace(/\r\n?/g, "\n").trim()), glossary);
  if (!script) throw new Error("model returned an empty script");
  const lang = input.settings.language;
  const pronunciationText = derivePronunciationText(delatex(raw.pronunciationText.trim()) || script, glossary, lang);
  // Subtitles must match what is spoken; models tend to condense their own subtitleText, so
  // derive it from the script and ignore raw.subtitleText.
  const subtitleText = deriveSubtitleText(script);
  const estimated = raw.estimatedDurationSec > 0 ? raw.estimatedDurationSec : estimateSpeakingSeconds(script, lang);
  return { script, pronunciationText, subtitleText, estimatedDurationSec: Math.round(estimated * 10) / 10 };
}

/**
 * Smaller models sometimes paste a glossary *reading* ("V O two max") into the display script.
 * Readings belong only in pronunciationText, so map any verbatim reading back to its term.
 */
export function restoreTermSpellings(script: string, glossary: GlossaryEntry[]): string {
  let out = script;
  for (const g of glossary) {
    const reading = (g.reading ?? "").trim();
    if (!reading || reading === g.term || reading.length < 3) continue;
    // Only readings that look like spelled-out forms (letters/spaces/digits), not Chinese names
    // such as 變異數分析, which are legitimate prose.
    if (!/^[A-Za-z0-9 .\-]+$/.test(reading)) continue;
    const re = new RegExp(reading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    out = out.replace(re, g.term);
  }
  return out;
}
