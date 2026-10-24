import type { SubtitleCue, SubtitleStyle } from "@lvs/shared";
import { assColor } from "./color.js";

// ---------------------------------------------------------------------------
// Line wrapping
// ---------------------------------------------------------------------------

const CJK_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯⺀-⿟]/u;
/** Characters that must not start a line (kinsoku shori, simplified). */
const NO_LINE_START = new Set([..."，。、；：！？）」』】》〉〕｝,.;:!?)]}%…—"]);

/** Width in CJK-equivalent columns, the unit of `SubtitleStyle.maxCharsPerLine` (shared with @lvs/pipeline). */
const len = (s: string) => {
  let w = 0;
  for (const ch of s) w += CJK_RE.test(ch) ? 1 : 0.5;
  return w;
};

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  const flush = () => {
    if (word) tokens.push(word);
    word = "";
  };
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      flush();
      if (tokens[tokens.length - 1] !== " ") tokens.push(" ");
    } else if (CJK_RE.test(ch)) {
      flush();
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  flush();
  return tokens;
}

/**
 * Rough rendered width in em: CJK / full-width glyphs are 1 em, everything else is
 * budgeted at 0.6 em (wide enough for most proportional Latin fonts).
 */
export function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += CJK_RE.test(ch) ? 1 : 0.6;
  return w;
}

/**
 * Greedy wrap. A line holds at most `maxChars` columns (CJK = 1, other = 0.5) and, when `maxEm` is given, at
 * most `maxEm` em of estimated width (so a large font on a small frame cannot overflow).
 * CJK text breaks between any two characters; Latin words are kept whole unless longer
 * than a full line. Closing punctuation is never moved to the start of a line (it may
 * overhang by one character). Explicit newlines in `text` are kept.
 */
export function wrapText(text: string, maxChars: number, maxEm = Number.POSITIVE_INFINITY): string[] {
  const fits = (s: string) => len(s) <= maxChars && emWidth(s) <= maxEm + 1e-9;
  /** Splits a token that cannot fit on an empty line into full-line chunks + remainder. */
  const hardSplit = (token: string, into: string[]): string => {
    let chunk = "";
    for (const ch of token) {
      if (chunk && !fits(chunk + ch)) {
        into.push(chunk);
        chunk = "";
      }
      chunk += ch;
    }
    return chunk;
  };

  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const lines: string[] = [];
    let line = "";
    let pendingSpace = false;
    for (const token of tokenize(paragraph.trim())) {
      if (token === " ") {
        pendingSpace = line.length > 0;
        continue;
      }
      const candidate = line + (pendingSpace ? " " : "") + token;
      pendingSpace = false;
      if (fits(candidate) || (line !== "" && NO_LINE_START.has(token))) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = fits(token) ? token : hardSplit(token, lines);
    }
    if (line) lines.push(line);
    out.push(...lines);
  }
  return out.filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// ASS
// ---------------------------------------------------------------------------

/** `H:MM:SS.cc` */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Neutralises ASS override syntax in user text. */
function escapeAssText(text: string): string {
  return text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");
}

function escapeAssField(text: string): string {
  return text.replace(/[,\r\n]/g, " ");
}

export interface AssOptions {
  width: number;
  height: number;
  style: SubtitleStyle;
  /** Cues outside [0, clipEndSec] are clipped. */
  clipEndSec?: number;
  /** Side margins as fractions of the width (keeps the line off the presenter); default 4% each. */
  sideMargins?: { left: number; right: number } | null;
}

/**
 * Builds an ASS script. PlayRes equals the frame size so `fontSizePx` / `marginPx` are
 * real pixels. The background box is drawn with BorderStyle 3 (opaque box) using
 * `backgroundColor` + `backgroundOpacity`.
 */
export function buildAss(cues: readonly SubtitleCue[], opts: AssOptions): string {
  const { style, width, height } = opts;
  const primary = assColor(style.color);
  const box = assColor(style.backgroundColor, style.backgroundOpacity);
  // No box + an outline width: classic outlined captions (BorderStyle 1) instead of the opaque box.
  const outlined = style.backgroundOpacity <= 0 && (style.outlineWidthPx ?? 0) > 0;
  const outline = outlined ? assColor(style.outlineColor ?? "#000000") : box;
  const bold = style.bold ? -1 : 0;
  const alignment = style.position === "top" ? 8 : 2;
  const boxPad = Math.max(2, Math.round(style.fontSizePx * 0.2));
  const sideMargin = Math.max(16, Math.round(width * 0.04));
  const marginL = opts.sideMargins ? Math.max(sideMargin, Math.round(width * opts.sideMargins.left)) : sideMargin;
  const marginR = opts.sideMargins ? Math.max(sideMargin, Math.round(width * opts.sideMargins.right)) : sideMargin;
  const font = escapeAssField(style.fontFamily);
  // Width actually available for text, in em of the subtitle font.
  const maxEm = Math.max(1, (width - marginL - marginR - 2 * boxPad) / style.fontSizePx);

  const header = [
    "[Script Info]",
    "; generated by @lvs/render",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    outlined
      ? `Style: Default,${font},${style.fontSizePx},${primary},${primary},${outline},${box},${bold},0,0,0,100,100,0,0,1,${style.outlineWidthPx},0,${alignment},${marginL},${marginR},${style.marginPx},1`
      : `Style: Default,${font},${style.fontSizePx},${primary},${primary},${box},${box},${bold},0,0,0,100,100,0,0,3,${boxPad},0,${alignment},${marginL},${marginR},${style.marginPx},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  for (const cue of [...cues].sort((a, b) => a.startSec - b.startSec)) {
    const start = Math.max(0, cue.startSec);
    const end = opts.clipEndSec !== undefined ? Math.min(cue.endSec, opts.clipEndSec) : cue.endSec;
    if (!(end > start)) continue;
    const lines = wrapText(escapeAssText(cue.text), style.maxCharsPerLine, maxEm);
    if (lines.length === 0) continue;
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${lines.join("\\N")}`);
  }
  return [...header, ...events, ""].join("\n");
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

/** `HH:MM:SS,mmm` */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

export interface TimedCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** Serialises cues (already on the global timeline) to SRT, renumbering from 1. */
export function buildSrt(cues: readonly TimedCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${c.text.replace(/\r\n/g, "\n").trim()}\n`)
    .join("\n");
}
