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
  /**
   * Silent gaps detected in the audio (e.g. ffmpeg silencedetect). Used when the TTS
   * provider gives no word timestamps: cue boundaries snap to the nearest pauses, which
   * TTS engines reliably insert at sentence punctuation.
   */
  pauses?: AudioPause[];
}

export interface AudioPause {
  startSec: number;
  endSec: number;
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
    if (cur && displayWidth(cur + c) > maxWidth && displayWidth(c) <= maxWidth) {
      chunks.push(cur.trim());
      cur = c;
    } else {
      // A clause too long for one cue anyway is joined to what precedes it and split evenly
      // below, so a short lead-in ("In this class,") never flashes by as a cue of its own.
      cur += cur && !/\s$/.test(cur) && /^[A-Za-z0-9]/.test(c) ? ` ${c}` : c;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  // split anything still too wide into evenly sized pieces
  return chunks.flatMap((c) => (displayWidth(c) <= maxWidth ? [c] : balancedWrap(c, maxWidth)));
}

/**
 * Split `text` into the fewest pieces that fit `maxWidth`, of about equal width, at word
 * (Latin) or character (CJK) boundaries. Greedy filling would leave a stub such as
 * "Consumption." as a last piece that is on screen for a fraction of a second.
 */
export function balancedWrap(text: string, maxWidth: number): string[] {
  const tokens = tokensForWrap(text);
  const total = displayWidth(text);
  for (let pieces = Math.ceil(total / maxWidth); pieces <= tokens.length; pieces++) {
    const target = total / pieces;
    const out: string[] = [];
    let cur = "";
    let fits = true;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const left = pieces - out.length; // pieces still to fill, this one included
      const next = cur + token;
      // Close the piece once it reaches the target width (or the next token would not fit),
      // keeping enough tokens for the pieces after it.
      if (cur && left > 1 && (displayWidth(next) > maxWidth || displayWidth(cur) >= target - displayWidth(token) / 2) && tokens.length - i >= left - 1) {
        out.push(cur.trim());
        cur = token.trimStart();
      } else {
        cur = next;
      }
      if (displayWidth(cur.trim()) > maxWidth) {
        fits = false;
        break;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    if (fits && out.every((p) => displayWidth(p) <= maxWidth)) return out;
  }
  return [text.trim()];
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

/**
 * Insert line breaks so no line exceeds `maxChars` columns. A cue that fits two lines gets
 * exactly two: at clause punctuation when both halves fit, else at the most even word or
 * character boundary — a comma break that pushed the rest onto a third line is never taken.
 */
export function wrapCueLines(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (displayWidth(trimmed) <= maxChars) return trimmed;
  if (displayWidth(trimmed) <= maxChars * MAX_LINES) {
    const toks = tokensForWrap(trimmed);
    let best: { at: number; score: number } | undefined;
    for (let i = 1; i < toks.length; i++) {
      const a = toks.slice(0, i).join("").trim();
      const b = toks.slice(i).join("").trim();
      if (!a || !b || displayWidth(a) > maxChars || displayWidth(b) > maxChars) continue;
      const clause = /[，、,；;：:]$/.test(a);
      const score = Math.abs(displayWidth(a) - displayWidth(b)) - (clause ? maxChars * 0.35 : 0);
      if (!best || score < best.score) best = { at: i, score };
    }
    if (best) return `${toks.slice(0, best.at).join("").trim()}\n${toks.slice(best.at).join("").trim()}`;
  }
  return greedyWrapLines(trimmed, maxChars);
}

function greedyWrapLines(text: string, maxChars: number): string {
  const lines: string[] = [];
  let rest = text.trim();
  while (displayWidth(rest) > maxChars) {
    const toks = tokensForWrap(rest);
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
    if (bestBreak < 0) break;
    const a = toks.slice(0, bestBreak + 1).join("").trim();
    const b = toks.slice(bestBreak + 1).join("").trim();
    if (!a || !b) break;
    lines.push(a);
    rest = b;
  }
  lines.push(rest);
  return lines.join("\n");
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
  } else if (input.pauses && input.pauses.length > 0) {
    // Only a cue that ends at punctuation can end at a pause: a sentence split mid-way has no
    // pause there, and snapping to a nearby breath squeezed one cue to a third of a second.
    const snappable = texts.slice(0, -1).map((t) => /[。！？!?.…，、,；;：:]["」』）)]*$/u.test(t.trim()));
    timing = alignToPauses(prop, input.pauses, input.durationSec, snappable);
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

/**
 * Snap the N-1 boundaries between proportionally placed cues onto detected pauses.
 * Each boundary is matched to a pause whose midpoint is as close as possible to its
 * proportional estimate, keeping order (dynamic programming over boundaries × pauses).
 * Boundaries that cannot be matched (fewer pauses than boundaries, or the best pause is
 * too far away) keep their proportional estimate. A cue ends when the pause starts and the
 * next cue begins when it ends, so subtitles never linger through the silence.
 */
export function alignToPauses(
  prop: Array<{ start: number; end: number }>,
  pauses: AudioPause[],
  durationSec: number,
  /** Per boundary (cue i | cue i+1): may it sit on a pause? Absent = all may. */
  snappable?: boolean[],
): Array<{ start: number; end: number }> {
  const n = prop.length;
  if (n < 2) return prop;
  // Ignore leading/trailing silence: only inner pauses separate cues.
  const inner = [...pauses]
    .filter((p) => p.endSec > 0.05 && p.startSec < durationSec - 0.05 && p.endSec > p.startSec && p.endSec - p.startSec <= 2.5)
    .sort((a, b) => a.startSec - b.startSec);
  const estimates = prop.slice(0, n - 1).map((c) => c.end);
  const m = inner.length;
  if (m === 0) return prop;
  const maxDrift = Math.max(1.5, durationSec * 0.12);
  const mid = inner.map((p) => (p.startSec + p.endSec) / 2);
  // Longer pauses are more likely sentence ends than comma breaths; give them a small head start.
  const cost = (b: number, j: number) =>
    snappable && snappable[b] === false ? Number.POSITIVE_INFINITY : Math.abs(mid[j]! - estimates[b]!) - 0.6 * Math.min(1, inner[j]!.endSec - inner[j]!.startSec);
  // dp[b][j]: best total cost assigning boundaries 0..b with boundary b -> pause j (or unmatched).
  const INF = Number.POSITIVE_INFINITY;
  const B = estimates.length;
  const dp: number[][] = Array.from({ length: B }, () => new Array<number>(m + 1).fill(INF));
  const from: number[][] = Array.from({ length: B }, () => new Array<number>(m + 1).fill(-1));
  // column m = "unmatched" sentinel carrying the drift penalty so matching is preferred when close.
  const unmatchedPenalty = maxDrift;
  for (let j = 0; j < m; j++) dp[0]![j] = cost(0, j) <= maxDrift ? cost(0, j) : INF;
  // (costs can be slightly negative thanks to the duration bonus; the DP still minimises a sum.)
  dp[0]![m] = unmatchedPenalty;
  for (let b = 1; b < B; b++) {
    // best over previous assignments with pause index < j (strictly increasing), or unmatched.
    let bestPrev: number = dp[b - 1]![m]!;
    let bestPrevIdx = m;
    for (let j = 0; j < m; j++) {
      // candidates for previous: unmatched (any), or pause k < j
      const c = cost(b, j);
      if (c <= maxDrift && bestPrev + c < dp[b]![j]!) {
        dp[b]![j] = bestPrev + c;
        from[b]![j] = bestPrevIdx;
      }
      if (dp[b - 1]![j]! < bestPrev) {
        bestPrev = dp[b - 1]![j]!;
        bestPrevIdx = j;
      }
    }
    // unmatched for boundary b: best of all previous states + penalty
    let best = INF;
    let bestIdx = -1;
    for (let j = 0; j <= m; j++) if (dp[b - 1]![j]! < best) { best = dp[b - 1]![j]!; bestIdx = j; }
    dp[b]![m] = best + unmatchedPenalty;
    from[b]![m] = bestIdx;
  }
  // backtrack
  let j = 0;
  for (let k = 1; k <= m; k++) if (dp[B - 1]![k]! < dp[B - 1]![j]!) j = k;
  const assigned: number[] = new Array(B).fill(-1);
  for (let b = B - 1; b >= 0; b--) {
    if (j < m) assigned[b] = j;
    j = from[b]![j]!;
    if (j < 0) j = m;
  }
  const out = prop.map((c) => ({ ...c }));
  for (let b = 0; b < B; b++) {
    const pj = assigned[b]!;
    if (pj < 0) continue;
    out[b]!.end = inner[pj]!.startSec;
    out[b + 1]!.start = inner[pj]!.endSec;
  }
  // Unmatched boundaries: keep proportional, but never cross a matched neighbour.
  for (let b = 0; b < B; b++) {
    if (assigned[b]! >= 0) continue;
    const lo = out[b]!.start + 0.3;
    const hi = out[b + 1]!.end - 0.3;
    const t = Math.min(Math.max(estimates[b]!, lo), Math.max(lo, hi));
    out[b]!.end = t;
    out[b + 1]!.start = t;
  }
  return out;
}
