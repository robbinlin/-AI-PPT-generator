/** Text segmentation helpers shared by subtitles and length estimates. */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const PUNCT = /[\s\p{P}\p{S}]/u;
const SENTENCE_END = /[。！？!?；;…]|\.(?=\s|$)|\n+/u;

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

export interface TextUnit {
  text: string;
  /** Code-point offsets into the source string. */
  start: number;
  end: number;
}

/** One unit per CJK character, one per Latin word. Punctuation is not a unit. */
export function textUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  const chars = Array.from(text);
  let wordStart = -1;
  const flush = (end: number) => {
    if (wordStart >= 0) {
      units.push({ text: chars.slice(wordStart, end).join(""), start: wordStart, end });
      wordStart = -1;
    }
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (isCjk(ch)) {
      flush(i);
      units.push({ text: ch, start: i, end: i + 1 });
    } else if (PUNCT.test(ch)) {
      flush(i);
    } else if (wordStart < 0) {
      wordStart = i;
    }
  }
  flush(chars.length);
  return units;
}

/** Speaking weight: a CJK char counts 1, a Latin word roughly its syllables. */
export function unitWeight(u: string): number {
  return isCjk(u) ? 1 : Math.max(1, Math.ceil(u.length / 3));
}

/** Split into sentences keeping the terminal punctuation attached. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  const chars = Array.from(text.replace(/\r\n?/g, "\n"));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    buf += ch;
    const next = chars[i + 1] ?? "";
    const isEnd = /[。！？!?；;…]/.test(ch) || ch === "\n" || (ch === "." && (next === "" || /\s/.test(next)));
    if (isEnd) {
      // swallow closing quotes/brackets that follow the terminator
      while (/[」』”’)）\]]/.test(chars[i + 1] ?? "")) buf += chars[++i];
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** Visible width for line fitting: CJK counts 1, Latin letters ~0.5. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += isCjk(ch) || /[＀-￯]/.test(ch) ? 1 : 0.5;
  return w;
}

export { SENTENCE_END };
