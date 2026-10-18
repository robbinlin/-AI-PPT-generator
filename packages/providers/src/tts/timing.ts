import type { WordTimestamp } from "@lvs/shared";

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const PUNCT = /[\s\p{P}\p{S}]/u;

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * Split text into timing units: one unit per CJK character, one per
 * whitespace-delimited Latin word. Punctuation and whitespace are not units.
 * Returns each unit with its character span in the original string.
 */
export function timingUnits(text: string): Array<{ text: string; start: number; end: number }> {
  const units: Array<{ text: string; start: number; end: number }> = [];
  const chars = Array.from(text); // code points
  let pos = 0; // index in code points
  let wordStart = -1;
  const flushWord = (endExclusive: number) => {
    if (wordStart >= 0) {
      units.push({ text: chars.slice(wordStart, endExclusive).join(""), start: wordStart, end: endExclusive });
      wordStart = -1;
    }
  };
  for (pos = 0; pos < chars.length; pos++) {
    const ch = chars[pos]!;
    if (isCjk(ch)) {
      flushWord(pos);
      units.push({ text: ch, start: pos, end: pos + 1 });
    } else if (PUNCT.test(ch)) {
      flushWord(pos);
    } else if (wordStart < 0) {
      wordStart = pos;
    }
  }
  flushWord(chars.length);
  return units;
}

/**
 * Character-level alignment (ElevenLabs style) -> unit-level WordTimestamps.
 * `characters[i]` has start/end seconds; indices refer to code points of the
 * joined character string, which equals the synthesised text.
 */
export function groupCharacterAlignment(alignment: {
  characters: string[];
  starts: number[];
  ends: number[];
}): WordTimestamp[] {
  const text = alignment.characters.join("");
  const out: WordTimestamp[] = [];
  for (const u of timingUnits(text)) {
    const s = alignment.starts[u.start];
    const e = alignment.ends[u.end - 1];
    if (s === undefined || e === undefined) continue;
    out.push({ text: u.text, startSec: s, endSec: Math.max(e, s) });
  }
  return out;
}

/** Evenly spread timing units over a duration (used by the mock provider and as a fallback). */
export function evenTimestamps(text: string, durationSec: number): WordTimestamp[] {
  const units = timingUnits(text);
  if (units.length === 0) return [];
  const weights = units.map((u) => (isCjk(u.text) ? 1 : Math.max(1, u.text.length / 3)));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return units.map((u, i) => {
    const d = (durationSec * weights[i]!) / total;
    const ts = { text: u.text, startSec: round(t), endSec: round(t + d) };
    t += d;
    return ts;
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
