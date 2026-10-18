import type { Language, SubtitleCue, SubtitleStyle, WordTimestamp } from "@lvs/shared";
import { displayWidth, splitSentences, textUnits, unitWeight } from "./segment.js";

export interface BuildCuesInput {
  subtitleText: string;
  timestamps?: WordTimestamp[];
  durationSec: number;
  maxCharsPerLine: number;
  language: Language;
  /** Minimum on-screen time per cue. */
  minCueSec?: number;
}

const MAX_LINES = 2;

/** Break one sentence into chunks that fit `maxLines` lines of `maxChars`, preferring clause punctuation. */
export function chunkSentence(sentence: string, maxChars: number, maxLines = MAX_LINES): string[] {
  const maxWidth = maxChars * maxLines;
  if (displayWidth(sentence) <= maxWidth) return [sentence];
  // split at clause punctuation first
  const clauses = sentence.split(/(?<=[，、,；;：:])\s*/u).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const c of clauses) {
    if (cur && displayWidth(cur + c) > maxWidth) {
      chunks.push(cur.trim());
      cur = c;
    } else {
      cur += c;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  // hard-wrap anything still too wide
  return chunks.flatMap((c) => (displayWidth(c) <= maxWidth ? [c] : hardWrap(c, maxWidth)));
}

function hardWrap(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const token of tokensForWrap(text)) {
    if (cur && displayWidth(cur + token) > maxWidth) {
      out.push(cur.trim());
      cur = token.trimStart();
    } else {
      cur += token;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Wrap tokens: CJK per char, Latin per word (with its trailing space). */
function tokensForWrap(text: string): string[] {
  const toks: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (/[㐀-鿿＀-￯　-〿]/.test(ch)) {
      if (buf) toks.push(buf);
      buf = "";
      toks.push(ch);
    } else {
      buf += ch;
      if (ch === " ") {
        toks.push(buf);
        buf = "";
      }
    }
  }
  if (buf) toks.push(buf);
  return toks;
}

/** Insert a line break so a cue of up to two lines wraps at a clause boundary when possible. */
export function wrapCueLines(text: string, maxChars: number): string {
  if (displayWidth(text) <= maxChars) return text;
  const toks = tokensForWrap(text);
  let bestBreak = -1;
  let width = 0;
  let lastClause = -1;
  for (let i = 0; i < toks.length; i++) {
    width += displayWidth(toks[i]!);
    if (/[，、,；;：:]$/.test(toks[i]!.trim()) && width <= maxChars) lastClause = i;
    if (width > maxChars) {
      bestBreak = lastClause >= 0 ? lastClause : i - 1;
      break;
    }
  }
  if (bestBreak < 0) return text;
  const a = toks.slice(0, bestBreak + 1).join("").trim();
  const b = toks.slice(bestBreak + 1).join("").trim();
  return b ? `${a}\n${b}` : a;
}

/** Split subtitle text into cue-sized pieces (no timing yet). */
export function segmentCueTexts(subtitleText: string, maxCharsPerLine: number): string[] {
  return splitSentences(subtitleText).flatMap((s) => chunkSentence(s, maxCharsPerLine));
}

/**
 * Build timed cues. With word timestamps we greedily match each cue's units to
 * the timestamp stream (exact text match within a look-ahead window), falling
 * back to proportional placement for unmatched units. Without timestamps the
 * cues are spread over `durationSec` by speaking weight.
 */
export function buildCues(input: BuildCuesInput): SubtitleCue[] {
  const minCue = input.minCueSec ?? 0.4;
  const texts = segmentCueTexts(input.subtitleText, input.maxCharsPerLine);
  if (texts.length === 0) return [];
  const cueUnits = texts.map((t) => textUnits(t));
  const weights = cueUnits.map((us) => us.reduce((a, u) => a + unitWeight(u.text), 0) || 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Proportional timing baseline.
  const prop: Array<{ start: number; end: number }> = [];
  let acc = 0;
  for (const w of weights) {
    const start = (acc / totalWeight) * input.durationSec;
    acc += w;
    prop.push({ start, end: (acc / totalWeight) * input.durationSec });
  }

  let timing = prop;
  const ts = input.timestamps;
  if (ts && ts.length > 0) {
    timing = alignToTimestamps(cueUnits, ts, prop);
  }

  // Monotonic clean-up.
  const cues: SubtitleCue[] = [];
  let prevEnd = 0;
  for (let i = 0; i < texts.length; i++) {
    let start = Math.max(timing[i]!.start, prevEnd);
    let end = Math.max(timing[i]!.end, start + minCue);
    const nextStart = i + 1 < texts.length ? timing[i + 1]!.start : input.durationSec;
    if (end > nextStart && nextStart > start + 0.1) end = nextStart;
    if (end > input.durationSec) end = input.durationSec;
    if (end <= start) end = Math.min(input.durationSec, start + 0.1);
    start = round3(start);
    end = round3(end);
    cues.push({
      index: i + 1,
      startSec: start,
      endSec: end,
      text: wrapCueLines(texts[i]!, input.maxCharsPerLine),
      ...(ts ? { words: wordsWithin(ts, start, end) } : {}),
    });
    prevEnd = end;
  }
  return cues;
}

function alignToTimestamps(
  cueUnits: ReturnType<typeof textUnits>[],
  ts: WordTimestamp[],
  prop: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const norm = (s: string) => s.toLowerCase();
  const WINDOW = 12;
  let p = 0;
  const out: Array<{ start: number; end: number }> = [];
  for (let c = 0; c < cueUnits.length; c++) {
    let first = -1;
    let last = -1;
    for (const u of cueUnits[c]!) {
      const target = norm(u.text);
      let found = -1;
      for (let j = p; j < Math.min(ts.length, p + WINDOW); j++) {
        if (norm(ts[j]!.text) === target) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        if (first < 0) first = found;
        last = found;
        p = found + 1;
      }
    }
    const start = first >= 0 ? ts[first]!.startSec : prop[c]!.start;
    const end = last >= 0 ? ts[last]!.endSec : prop[c]!.end;
    out.push({ start, end: Math.max(end, start) });
  }
  return out;
}

function wordsWithin(ts: WordTimestamp[], start: number, end: number): WordTimestamp[] {
  return ts.filter((w) => w.startSec >= start - 1e-6 && w.endSec <= end + 1e-6);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ------------------------------------------------------------- exporters --

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

export function formatSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

export function cuesToSrt(cues: SubtitleCue[]): string {
  return (
    cues.map((c) => `${c.index}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text}`).join("\n\n") + (cues.length ? "\n" : "")
  );
}

export function formatAssTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs % 100, 2)}`;
}

/** `#RRGGBB` + opacity (0..1) -> ASS `&HAABBGGRR` (AA = 00 opaque .. FF transparent). */
export function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  const [r, g, b] = m ? [m[1]!, m[2]!, m[3]!] : ["FF", "FF", "FF"];
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return `&H${alpha.toString(16).padStart(2, "0")}${b}${g}${r}`.toUpperCase();
}

function escapeAss(text: string): string {
  return text.replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\r?\n/g, "\\N");
}

/** ASS subtitle file for burn-in via ffmpeg's `subtitles`/`ass` filter. */
export function cuesToAss(cues: SubtitleCue[], style: SubtitleStyle, width: number, height: number): string {
  const alignment = style.position === "top" ? 8 : 2;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    [
      "Style: Default",
      style.fontFamily,
      style.fontSizePx,
      assColor(style.color, 1),
      assColor(style.color, 1),
      assColor(style.backgroundColor, style.backgroundOpacity),
      assColor(style.backgroundColor, style.backgroundOpacity),
      0, 0, 0, 0, 100, 100, 0, 0,
      3, // BorderStyle 3 = opaque box
      Math.max(2, Math.round(style.fontSizePx * 0.25)), // box padding
      0,
      alignment,
      Math.round(width * 0.05),
      Math.round(width * 0.05),
      style.marginPx,
      1,
    ].join(","),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = cues.map((c) => `Dialogue: 0,${formatAssTime(c.startSec)},${formatAssTime(c.endSec)},Default,,0,0,0,,${escapeAss(c.text)}`);
  return [...header, ...lines].join("\n") + "\n";
}
