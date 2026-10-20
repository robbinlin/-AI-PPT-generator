import { z } from "zod";
import type { GlossaryEntry, LlmAttachment, LlmProvider, OutlineRevision, ProjectSettings, UsageDelta } from "@lvs/shared";
import { contentHash } from "@lvs/shared";
import { outlineInputHash } from "./hashes.js";
import { describeAudience, describeLanguage, describeMode, isZh, renderGlossary, renderSlideContent, type PipelineSlide } from "./prompts.js";
import { textUnits, unitWeight } from "./segment.js";

export const MIN_SLIDE_SEC = 15;
export const MAX_SLIDE_SEC = 90;

/** What we ask the model for. Uses 1-based slide numbers instead of ids; all fields required (structured-output friendly). */
export const OutlineLlmOutput = z.object({
  objectives: z.array(z.string()),
  summary: z.string(),
  sections: z.array(
    z.object({
      title: z.string(),
      slideNumbers: z.array(z.number().int().min(1)),
      keyPoints: z.array(z.string()),
    }),
  ),
  glossary: z.array(z.object({ term: z.string(), reading: z.string(), definition: z.string() })),
  timeAllocation: z.array(z.object({ slideNumber: z.number().int().min(1), seconds: z.number().min(0) })),
});
export type OutlineLlmOutput = z.infer<typeof OutlineLlmOutput>;

export type OutlineDraft = Omit<OutlineRevision, "id" | "projectId" | "version" | "createdAt">;

export interface GenerateOutlineInput {
  llm: LlmProvider;
  slides: PipelineSlide[];
  settings: ProjectSettings;
  glossarySeed?: GlossaryEntry[];
  /** Attach slide images to the prompt (default: true when images are present, capped). */
  attachImages?: boolean;
  maxImages?: number;
}

export interface GenerateOutlineResult {
  outline: OutlineDraft;
  usage: UsageDelta[];
}

export function buildOutlinePrompt(input: GenerateOutlineInput): { system: string; prompt: string } {
  const { settings, slides } = input;
  const zh = isZh(settings);
  const seed = input.glossarySeed ?? [];
  const target = settings.targetDurationSec;
  const slidesText = slides.map((s) => renderSlideContent(s)).join("\n\n");

  const system = zh
    ? `你是一位大學課程的教學設計師與講師，負責把一份投影片規劃成一支完整的教學解說影片。
你先閱讀整份投影片，再產出全篇規劃：教學目標、章節劃分、每頁重點、術語表（含朗讀方式）與每頁時間分配。
規劃是給後續「逐頁講稿撰寫」使用的，因此要讓每頁的講稿能前後銜接、術語一致、不重複開場。
輸出必須是符合指定 JSON 結構的資料，所有文字使用${describeLanguage(settings)}。`
    : `You are an instructional designer and lecturer planning a narrated lecture video from a slide deck.
Read the whole deck first, then produce a deck-level plan: learning objectives, sections, key points per slide, a glossary with how to pronounce each term, and a time allocation per slide.
The plan feeds a later per-slide script writer, so it must give that writer enough context to keep slides connected, terminology consistent, and to avoid re-introducing the talk on every slide.
Return data matching the requested JSON structure. Write all text in ${describeLanguage(settings)}.`;

  const rules = zh
    ? [
        `對象：${describeAudience(settings)}。`,
        `講解模式：${describeMode(settings)}。`,
        settings.contentBoundary === "source_only"
          ? "內容邊界：只能根據投影片與備忘稿的內容，不可自行補充研究數據、引用或外部事實。"
          : "內容邊界：允許補充背景知識，但在 keyPoints 中以「補充：」開頭標示非投影片內容。",
        settings.styleNote ? `風格要求：${settings.styleNote}` : "",
        "sections 必須涵蓋每一頁且每頁只屬於一個 section，slideNumbers 使用上方標示的 Slide 編號。",
        "glossary 請列出所有統計符號、縮寫、英文術語、人名與專有名詞，reading 寫出適合語音朗讀的讀法（例如 VO₂max → V O two max；ANOVA → 變異數分析；η² → 伊塔平方；p < .05 → p 小於 零點零五；95% CI → 百分之九十五信賴區間；作者姓名用中文音譯）。reading 只能給一種讀法，不可用「或」並列多種；用書面語，不用「趴」等口語；希臘字母與統計量優先用中文名稱。不需要讀法時 reading 填空字串。",
        target
          ? `timeAllocation 每頁的秒數總和必須等於 ${target} 秒，依內容密度分配。`
          : `timeAllocation 依內容密度分配，每頁介於 ${MIN_SLIDE_SEC} 到 ${MAX_SLIDE_SEC} 秒。`,
        "summary 用 3 到 5 句話描述整份教材的脈絡，objectives 列出 3 到 6 條學習目標。",
      ]
    : [
        `Audience: ${describeAudience(settings)}.`,
        `Mode: ${describeMode(settings)}.`,
        settings.contentBoundary === "source_only"
          ? "Content boundary: use only what is on the slides and in speaker notes; never invent data, citations or external facts."
          : "Content boundary: background knowledge is allowed but prefix any non-slide key point with 'Supplement:'.",
        settings.styleNote ? `Style: ${settings.styleNote}` : "",
        "sections must cover every slide exactly once; use the Slide numbers shown above in slideNumbers.",
        "glossary must list every statistical symbol, abbreviation, technical term, author name and proper noun with a `reading` suitable for text-to-speech (e.g. VO₂max → V O two max; ANOVA → A N O V A; η² → eta squared; p < .05 → p less than point zero five). Give exactly one reading per term, never alternatives joined by \"or\". Use an empty string when no special reading is needed.",
        target
          ? `timeAllocation seconds must sum to exactly ${target}, distributed by content density.`
          : `timeAllocation by content density, each slide between ${MIN_SLIDE_SEC} and ${MAX_SLIDE_SEC} seconds.`,
        "summary: 3–5 sentences on the arc of the deck; objectives: 3–6 learning objectives.",
      ];

  const candidates = extractTermCandidates(input.slides);
  const prompt = [
    zh ? "## 投影片內容" : "## Slide content",
    slidesText,
    "",
    zh ? "## 已知術語（請納入並補齊讀法）" : "## Known glossary (include and complete readings)",
    renderGlossary(seed, zh),
    "",
    zh
      ? "## 候選術語（從投影片自動偵測；每一個都要出現在 glossary 並給讀法，另外補上你發現的其他術語與人名）"
      : "## Term candidates (auto-detected; every one must appear in glossary with a reading, add any others you notice)",
    candidates.length ? candidates.join("、") : zh ? "（無）" : "(none)",
    "",
    zh ? "## 規劃要求" : "## Planning requirements",
    ...rules.filter(Boolean).map((r) => `- ${r}`),
  ].join("\n");

  return { system, prompt };
}

/** Content-density default allocation used when the model's numbers are unusable. */
export function defaultTimeAllocation(slides: PipelineSlide[], targetDurationSec?: number): Record<string, number> {
  const weights = slides.map((s) => {
    const text = [s.content.plainText, s.content.notes ?? ""].join(" ");
    const w = textUnits(text).reduce((a, u) => a + unitWeight(u.text), 0);
    return Math.max(20, w + s.content.tables.length * 40 + s.content.charts.length * 30 + s.content.images.length * 10);
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Record<string, number> = {};
  if (targetDurationSec) {
    slides.forEach((s, i) => (out[s.id] = Math.round((weights[i]! / total) * targetDurationSec)));
    return out;
  }
  // ~4.5 chars/s speaking, clamped
  slides.forEach((s, i) => (out[s.id] = Math.min(MAX_SLIDE_SEC, Math.max(MIN_SLIDE_SEC, Math.round(weights[i]! / 4.5)))));
  return out;
}

/** Map model output back to slide ids, repair coverage and time sums. */
export function normalizeOutline(raw: OutlineLlmOutput, input: Pick<GenerateOutlineInput, "slides" | "settings" | "glossarySeed">): OutlineDraft {
  const { slides, settings } = input;
  const byNumber = new Map<number, PipelineSlide>();
  slides.forEach((s) => byNumber.set(s.index + 1, s));

  // sections: keep valid, unique slide refs; append an "other" section for anything uncovered
  const seen = new Set<string>();
  const sections = raw.sections
    .map((sec) => ({
      title: sec.title,
      slideIds: sec.slideNumbers.map((n) => byNumber.get(n)?.id).filter((id): id is string => !!id && !seen.has(id) && (seen.add(id), true)),
      keyPoints: sec.keyPoints,
    }))
    .filter((sec) => sec.slideIds.length > 0);
  const uncovered = slides.filter((s) => !seen.has(s.id)).map((s) => s.id);
  if (uncovered.length) sections.push({ title: isZh(settings) ? "其他" : "Other", slideIds: uncovered, keyPoints: [] });

  // glossary: merge seed (seed readings win when the model left them blank)
  const seedMap = new Map((input.glossarySeed ?? []).map((g) => [g.term, g]));
  const glossary: GlossaryEntry[] = [];
  const terms = new Set<string>();
  for (const g of [...raw.glossary, ...(input.glossarySeed ?? [])]) {
    const term = g.term.trim();
    if (!term || terms.has(term)) continue;
    terms.add(term);
    const seed = seedMap.get(term);
    const reading = normalizeReading(g.reading || seed?.reading || "");
    const definition = (g.definition || seed?.definition || "").trim();
    glossary.push({ term, ...(reading ? { reading } : {}), ...(definition ? { definition } : {}) });
  }

  // time allocation
  const fallback = defaultTimeAllocation(slides, settings.targetDurationSec);
  const timeAllocation: Record<string, number> = {};
  for (const s of slides) {
    const m = raw.timeAllocation.find((t) => byNumber.get(t.slideNumber)?.id === s.id);
    const v = m && m.seconds > 0 ? m.seconds : fallback[s.id]!;
    timeAllocation[s.id] = settings.targetDurationSec ? v : Math.min(MAX_SLIDE_SEC, Math.max(MIN_SLIDE_SEC, v));
  }
  if (settings.targetDurationSec) {
    const sum = Object.values(timeAllocation).reduce((a, b) => a + b, 0) || 1;
    const k = settings.targetDurationSec / sum;
    for (const id of Object.keys(timeAllocation)) timeAllocation[id] = Math.round(timeAllocation[id]! * k);
    // fix rounding drift on the last slide
    const drift = settings.targetDurationSec - Object.values(timeAllocation).reduce((a, b) => a + b, 0);
    const last = slides.at(-1);
    if (last && drift !== 0) timeAllocation[last.id] = Math.max(1, timeAllocation[last.id]! + drift);
  }

  return {
    objectives: raw.objectives.map((o) => o.trim()).filter(Boolean),
    summary: raw.summary.trim(),
    sections,
    glossary,
    timeAllocation,
    inputHash: outlineInputHash({ slideContentHashes: slides.map((s) => slideHashOf(s)), settings }),
  };
}

/** Slides carry their hash on the entity; the pipeline recomputes from content when not provided. */
export function slideHashOf(slide: PipelineSlide & { contentHash?: string }): string {
  return slide.contentHash ?? hashSlideContent(slide);
}

/** Same recipe the API uses for `Slide.contentHash`: plain text + speaker notes. */
export function hashSlideContent(slide: PipelineSlide): string {
  return contentHash({ text: slide.content.plainText, notes: slide.content.notes ?? "" });
}

export async function generateOutline(input: GenerateOutlineInput): Promise<GenerateOutlineResult> {
  if (input.slides.length === 0) throw new Error("generateOutline: no slides");
  const { system, prompt } = buildOutlinePrompt(input);
  const attach = input.attachImages ?? true;
  const maxImages = input.maxImages ?? 40;
  const attachments: LlmAttachment[] = attach
    ? input.slides
        .filter((s) => s.imagePng)
        .slice(0, maxImages)
        .map((s) => ({ mimeType: "image/png", data: s.imagePng!, label: `Slide ${s.index + 1} image` }))
    : [];
  const res = await input.llm.generateJson({
    system,
    prompt,
    schema: OutlineLlmOutput,
    ...(attachments.length ? { attachments } : {}),
    temperature: 0.3,
    reasoning: "low",
  });
  return { outline: normalizeOutline(res.data, input), usage: res.usage };
}

/** Keep a single pronunciation: models sometimes return "A 或 B" / "A or B"; TTS would read the conjunction aloud. */
export function normalizeReading(reading: string): string {
  const first = reading.split(/\s*(?:或|or)\s+/i)[0] ?? "";
  return first.replace(/([0-9０-９零一二三四五六七八九十百千點.]+)\s*趴/g, "百分之$1").trim();
}

const STOP_WORDS = new Set(["the", "and", "of", "to", "in", "for", "with", "on", "by", "vs", "et", "al", "is", "are", "or", "an", "a", "as", "at"]);

/**
 * Deterministically pulls abbreviations, symbols, statistics notation and proper names out of
 * the slides so the glossary does not depend on how thorough the model feels like being.
 */
export function extractTermCandidates(slides: PipelineSlide[], max = 60): string[] {
  const counts = new Map<string, number>();
  const bump = (t: string) => counts.set(t, (counts.get(t) ?? 0) + 1);
  const text = slides.map((s) => [s.content.plainText, s.content.notes ?? ""].join("\n")).join("\n");
  const patterns: RegExp[] = [
    // statistics notation: p < .05, F(4, 110) = 6.21, η² = .18, r = .62, 95% CI, t(38) = 2.45
    /\b[pFtrdz]\s*\(?[\d, ]*\)?\s*[<>=≤≥]\s*-?\.?\d[\d.]*/g,
    /[ηρσμαβχ]²?\s*=\s*-?\.?\d[\d.]*/g,
    /\d{1,3}%\s*CI/g,
    // units and ratios: mL/kg/min, L/min, kg·m⁻²
    /\b[A-Za-zµ]{1,4}(?:\/[A-Za-zµ]{1,4}){1,3}\b/g,
    // acronyms / mixed-case tokens with digits or subscripts: HIIT, MICT, VO₂max, ANOVA, SPSS, Tukey HSD
    /\b[A-Z][A-Za-z]*[₀-₉0-9][A-Za-z₀-₉0-9]*\b|\b[A-Z]{2,}[a-z]*\b/g,
    // capitalised names (authors): Gibala, Cohen's, Levene
    /\b[A-Z][a-z]{2,}(?:'s)?\b/g,
    // greek letters standing alone
    /(?<![A-Za-z])[ηρσμαβχ]²?(?![A-Za-z])/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const t = m[0].trim();
      if (!t || STOP_WORDS.has(t.toLowerCase())) continue;
      bump(t);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}
