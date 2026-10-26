import { applyGlossaryReadings, isTranslationNotReading, type GlossaryEntry, type Language } from "@lvs/shared";

/**
 * Deterministic text derivations. The script is what the user reads; the
 * pronunciation text is what the TTS engine reads; the subtitle text is what
 * appears on screen.
 */

const ZH_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const ZH_UNITS = ["", "十", "百", "千"];
const ZH_BIG = ["", "萬", "億", "兆"];

/** Integer -> Traditional Chinese numeral (up to 10^16). Spoken form: 110 -> 一百一十. */
export function integerToChinese(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e16) return String(n);
  if (n === 0) return "零";
  let s = String(Math.floor(n));
  const groups: number[] = [];
  while (s.length) {
    groups.unshift(Number(s.slice(-4)));
    s = s.slice(0, -4);
  }
  let out = "";
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (g === 0) continue;
    const bigIdx = groups.length - 1 - i;
    // 一萬零五 / 一萬零五百: a gap or a short group after a bigger one needs 零
    if (out && (g < 1000 || groups[i - 1] === 0)) out += "零";
    out += groupToChinese(g, i === 0) + ZH_BIG[bigIdx];
  }
  return out;
}

function groupToChinese(g: number, leading: boolean): string {
  let out = "";
  let zero = false;
  for (let pos = 3; pos >= 0; pos--) {
    const d = Math.floor(g / 10 ** pos) % 10;
    if (d === 0) {
      zero = out.length > 0;
      continue;
    }
    if (zero) out += "零";
    out += ZH_DIGITS[d]! + ZH_UNITS[pos];
    zero = false;
  }
  // 十五 rather than 一十五 when the whole number is 10..19
  return leading && g < 20 ? out.replace(/^一十/, "十") : out;
}

/** "0.05" -> "零點零五", "12.5" -> "十二點五" */
export function decimalToChinese(s: string): string {
  const [int = "0", frac] = s.split(".");
  const intPart = integerToChinese(Number(int || "0"));
  if (!frac) return intPart;
  return intPart + "點" + Array.from(frac).map((d) => ZH_DIGITS[Number(d)] ?? d).join("");
}

/** "0.05" -> "point zero five", "12.5" -> "twelve point five" is overkill; TTS reads digits fine. */
function decimalToEnglish(s: string): string {
  const [int = "0", frac] = s.split(".");
  if (!frac) return int;
  return `${int === "" ? "zero" : int} point ${Array.from(frac).join(" ")}`;
}

const SUBSCRIPTS: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
const SUPERSCRIPTS: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };

const DIGIT_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * μ in Chinese narration, the way the lecturer says it: μ → Mu, μ₀ → Mu0, μ₁ → Mu one (μ₂ → Mu two …),
 * μ_diff → Mu diff. Subscript digits are already plain digits here (normaliseScripts).
 */
const MU_ZH: Array<[RegExp, string | ((m: string, d: string) => string)]> = [
  // Spaces only where a word touches it, so 「，μ₁」 does not become 「， Mu one」.
  [/(?<=[\p{L}\p{N}])(?=[μµ])/gu, " "],
  [/[μµ]\s*_?\s*0(?!\d)/g, "Mu0"],
  [/[μµ]\s*_?\s*([1-9])(?!\d)(?=[\p{L}\p{N}])/gu, (_m, d) => `Mu ${DIGIT_EN[Number(d)]} `],
  [/[μµ]\s*_?\s*([1-9])(?!\d)/g, (_m, d) => `Mu ${DIGIT_EN[Number(d)]}`],
  [/[μµ]\s*_\s*/g, "Mu "],
  [/[μµ](?=[\p{L}\p{N}])/gu, "Mu "],
  [/[μµ]/g, "Mu"],
];

/**
 * Reading of a glossary term that is μ with a subscript (μ₀, μ1, μ_diff …), or undefined when it is not
 * one. Bare μ gets no reading ("") so the rules above still see μ₀, μ_diff in the narration.
 */
export function muReading(term: string): string | undefined {
  const t = normaliseScripts(term.trim());
  if (/^[μµ]$/.test(t)) return "";
  if (!/^[μµ]\s*(_?\s*[\w\p{Script=Han}]*)$/u.test(t)) return undefined;
  let out = t;
  for (const [re, rep] of MU_ZH) out = out.replace(re, rep as never);
  return out.replace(/\s{2,}/g, " ").trim();
}

const SYMBOLS_ZH: Array<[RegExp, string | ((m: string, d: string) => string)]> = [
  [/\s*≤\s*/g, " 小於等於 "],
  [/\s*≥\s*/g, " 大於等於 "],
  [/\s*≠\s*/g, " 不等於 "],
  [/\s*≈\s*/g, " 約等於 "],
  [/\s*±\s*/g, " 正負 "],
  [/\s*×\s*/g, " 乘以 "],
  [/\s*÷\s*/g, " 除以 "],
  [/\s*→\s*/g, " 到 "],
  [/\s*<\s*/g, " 小於 "],
  [/\s*>\s*/g, " 大於 "],
  [/(?<=[\p{L}\p{N})])\s*=\s*(?=[\p{L}\p{N}.(-])/gu, " 等於 "],
  [/α/g, "阿爾法"],
  [/β/g, "貝塔"],
  [/γ/g, "伽瑪"],
  [/δ|Δ/g, "德爾塔"],
  ...MU_ZH,
  [/σ/g, "西格瑪"],
  [/η²|η2/g, "eta 平方"],
  [/χ²|χ2/g, "卡方"],
  [/°C/g, " 攝氏度"],
  [/°/g, " 度"],
  [/‰/g, " 千分比"],
];

const SYMBOLS_EN: Array<[RegExp, string]> = [
  [/\s*≤\s*/g, " less than or equal to "],
  [/\s*≥\s*/g, " greater than or equal to "],
  [/\s*≠\s*/g, " not equal to "],
  [/\s*≈\s*/g, " approximately "],
  [/\s*±\s*/g, " plus or minus "],
  [/\s*×\s*/g, " times "],
  [/\s*÷\s*/g, " divided by "],
  [/\s*→\s*/g, " to "],
  [/\s*<\s*/g, " less than "],
  [/\s*>\s*/g, " greater than "],
  [/(?<=[\p{L}\p{N})])\s*=\s*(?=[\p{L}\p{N}.(-])/gu, " equals "],
  [/α/g, "alpha"],
  [/β/g, "beta"],
  [/γ/g, "gamma"],
  [/δ|Δ/g, "delta"],
  [/μ/g, "mu"],
  [/σ/g, "sigma"],
  [/η²|η2/g, "eta squared"],
  [/χ²|χ2/g, "chi squared"],
  [/°C/g, " degrees Celsius"],
  [/°/g, " degrees"],
  [/%/g, " percent"],
  [/‰/g, " per mille"],
];

const NUMBER_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(?![\w.])/g;


/** Replace glossary terms (longest first) with their readings. Case-sensitive for Latin to avoid mangling prose. */
// Glossary matching lives in @lvs/shared so the API and the editor use the same rule.
export { applyGlossaryReadings, isTranslationNotReading };

/** Normalise sub/superscript digits so VO₂max becomes VO2max when no reading exists. */
export function normaliseScripts(text: string): string {
  return text.replace(/[₀-₉]/g, (c) => SUBSCRIPTS[c] ?? c).replace(/[⁰-⁹¹²³]/g, (c) => SUPERSCRIPTS[c] ?? c);
}

function expandNumbersZh(text: string): string {
  // percentages: 25% -> 百分之二十五 ; 12.5% -> 百分之十二點五
  let out = text.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n: string) => `百分之${decimalToChinese(n)}`);
  // p-values and other bare decimals: .05 / 0.05 -> 零點零五 (only decimals; integers stay as digits)
  out = out.replace(NUMBER_RE, (m, int: string | undefined, frac: string | undefined) => {
    if (!frac) return m;
    const i = (int ?? "0").replace(/,/g, "");
    return decimalToChinese(`${i}${frac}`);
  });
  return out;
}

function expandNumbersEn(text: string): string {
  return text.replace(NUMBER_RE, (m, int: string | undefined, frac: string | undefined) => {
    if (!frac) return m;
    return decimalToEnglish(`${int ?? ""}${frac}`);
  });
}

/**
 * Build what the TTS engine should read: glossary readings, statistical
 * symbols, decimals and percentages expanded in the target language.
 */
export function derivePronunciationText(script: string, glossary: GlossaryEntry[], language: Language): string {
  let t = applyGlossaryReadings(script, glossary);
  t = normaliseScripts(t);
  const zh = language !== "en";
  for (const [re, rep] of zh ? SYMBOLS_ZH : SYMBOLS_EN) t = t.replace(re, rep as never);
  t = zh ? expandNumbersZh(t) : expandNumbersEn(t);
  return t.replace(/[ \t]{2,}/g, " ").replace(/ +([，。！？、；：])/g, "$1").trim();
}

/** On-screen text keeps formal spelling; only whitespace is normalised. */
export function deriveSubtitleText(script: string): string {
  return script
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Rough speaking time: ~4.5 CJK chars/s, ~2.5 Latin words/s. */
export function estimateSpeakingSeconds(text: string, language: Language): number {
  let cjk = 0;
  let latinWords = 0;
  for (const w of text.split(/\s+/)) {
    for (const ch of w) if (/[㐀-鿿]/.test(ch)) cjk++;
    if (/[A-Za-z]/.test(w)) latinWords++;
  }
  const seconds = cjk / 4.5 + latinWords / 2.5;
  return Math.round(Math.max(language === "en" ? latinWords / 2.5 : seconds, seconds) * 10) / 10;
}

/** Target character / word count for a time allocation. */
export function targetLength(allocatedSec: number, language: Language): { chars?: number; words?: number } {
  return language === "en" ? { words: Math.round(allocatedSec * 2.5) } : { chars: Math.round(allocatedSec * 4.5) };
}
