import type { GlossaryEntry, ProjectSettings, SlideContent } from "@lvs/shared";

/** Slide as the pipeline sees it: the parsed content plus optional rendered image. */
export interface PipelineSlide {
  id: string;
  /** 0-based position in the deck. */
  index: number;
  content: SlideContent;
  imagePng?: Uint8Array;
}

export function isZh(settings: ProjectSettings): boolean {
  return settings.language !== "en";
}

const AUDIENCE_ZH: Record<ProjectSettings["audience"], string> = {
  undergraduate: "大學部學生",
  graduate: "研究生",
  general: "一般民眾",
  custom: "自訂對象",
};
const AUDIENCE_EN: Record<ProjectSettings["audience"], string> = {
  undergraduate: "undergraduate students",
  graduate: "graduate students",
  general: "the general public",
  custom: "a custom audience",
};
const MODE_ZH: Record<ProjectSettings["mode"], string> = {
  faithful: "照稿解說：忠實講解投影片內容，不額外延伸",
  extended: "教學延伸：在投影片內容之上補充說明、舉例與銜接",
  summary: "重點摘要：只講每頁最重要的結論與關鍵數據",
};
const MODE_EN: Record<ProjectSettings["mode"], string> = {
  faithful: "faithful: explain exactly what is on the slide, no additions",
  extended: "extended: teach beyond the slide with explanations, examples and transitions",
  summary: "summary: only the key conclusions and numbers on each slide",
};

export function describeAudience(settings: ProjectSettings): string {
  const base = isZh(settings) ? AUDIENCE_ZH[settings.audience] : AUDIENCE_EN[settings.audience];
  return settings.audienceNote ? `${base}（${settings.audienceNote}）` : base;
}

export function describeMode(settings: ProjectSettings): string {
  return isZh(settings) ? MODE_ZH[settings.mode] : MODE_EN[settings.mode];
}

export function describeLanguage(settings: ProjectSettings): string {
  switch (settings.language) {
    case "zh-TW":
      return "繁體中文（台灣用語）";
    case "en":
      return "English";
    case "mixed":
      return "繁體中文為主，專業術語保留英文";
  }
}

/** Compact, model-readable rendering of one slide's structured content. */
export function renderSlideContent(slide: PipelineSlide, opts: { includeNotes?: boolean; maxChars?: number } = {}): string {
  const c = slide.content;
  const lines: string[] = [];
  lines.push(`### Slide ${slide.index + 1} (page ${c.pageNumber})`);
  if (c.title) lines.push(`Title: ${c.title}`);
  for (const b of c.textBlocks) {
    if (b.role === "title" && b.text === c.title) continue;
    const indent = "  ".repeat(b.level);
    const prefix = b.role === "bullet" ? "- " : b.role === "caption" ? "(caption) " : "";
    lines.push(`${indent}${prefix}${b.text}`);
  }
  for (const t of c.tables) {
    lines.push("Table:");
    for (const row of t.rows) lines.push("| " + row.join(" | ") + " |");
  }
  for (const ch of c.charts) {
    lines.push(`Chart${ch.chartType ? ` (${ch.chartType})` : ""}: ${ch.title ?? ""} ${ch.dataSummary ?? ""}`.trim());
  }
  if (c.images.length) lines.push(`Images: ${c.images.length}${c.images.some((i) => i.altText) ? " — " + c.images.map((i) => i.altText).filter(Boolean).join("; ") : ""}`);
  if (opts.includeNotes !== false && c.notes) lines.push(`Speaker notes: ${c.notes}`);
  if (c.needsOcr) lines.push("(scanned page, no text layer — rely on the image)");
  let out = lines.join("\n");
  if (opts.maxChars && out.length > opts.maxChars) out = out.slice(0, opts.maxChars) + " …";
  return out;
}

export function renderGlossary(glossary: GlossaryEntry[], zh: boolean): string {
  if (!glossary.length) return zh ? "（無）" : "(none)";
  return glossary
    .map((g) => `- ${g.term}${g.reading ? (zh ? `｜讀法：${g.reading}` : ` | say: ${g.reading}`) : ""}${g.definition ? (zh ? `｜${g.definition}` : ` | ${g.definition}`) : ""}`)
    .join("\n");
}

/** Short one-line summary of a neighbouring slide for continuity. */
export function slideBrief(slide: PipelineSlide, maxChars = 160): string {
  const c = slide.content;
  const text = [c.title, ...c.textBlocks.filter((b) => b.role !== "title").map((b) => b.text)].filter(Boolean).join("；");
  const t = text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  return `Slide ${slide.index + 1}: ${t || "(no text)"}`;
}
