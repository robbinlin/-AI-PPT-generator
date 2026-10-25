import type { GlossaryEntry } from "./entities.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where a glossary term counts as used. Latin terms only as a whole word: not inside a longer
 * word (sub/superscript digits count as part of it: 「VO」 is not 「VO₂」), and not glued to a
 * hyphen, slash or closing bracket (「Two」 must not change 「Two-way」,
 * 「O₂」 must not change 「(a-v)O₂ diff」). CJK terms match anywhere.
 */
export function glossaryTermRegex(term: string): RegExp {
  const t = escapeRegExp(term);
  return /^[\w.₀-₉⁰-⁹-]+$/u.test(term) ? new RegExp(`(?<![\\w\\-)/₀-₉⁰-⁹²³¹])${t}(?![\\w\\-/₀-₉⁰-⁹²³¹])`, "gu") : new RegExp(t, "gu");
}

export function usesGlossaryTerm(text: string, term: string): boolean {
  return term.trim() !== "" && glossaryTermRegex(term).test(text);
}

/**
 * A plain lowercase word (mean, standard deviation), a path or URL (org/mrsc) or a spelled-out
 * number (Two) with a purely Chinese "reading" is a translation, not a pronunciation:
 * substituting it turns 「平均數，也就是 mean」 into 「平均數，也就是平均數」. Modern TTS engines say
 * such words fine, so keep them. Names (Smith → 史密斯), acronyms (ANOVA) and anything with digits
 * or symbols (VO₂max, η²) keep their readings; the outline shows which pages each one changes.
 */
const UNITS = new Set(
  "ml l dl kg g mg μg µg mcg min s sec h hr d wk yr km m cm mm kcal cal j kj w bpm beat beats mmol mol mmhg rep reps set sets lb lbs".split(" "),
);

/** 「mL/kg/min」, 「L/min」, 「m/s²」: every slash-separated part a unit. */
function isUnit(term: string): boolean {
  return term.split("/").every((part) => UNITS.has(part.replace(/[0-9²³⁻¹]+$/u, "").toLowerCase()));
}

export function isTranslationNotReading(term: string, reading: string): boolean {
  const w = term.trim();
  const chineseOnly = /^[\p{Script=Han}\s，、]+$/u.test(reading.trim());
  if (!chineseOnly) return false;
  const plainWord = /^[a-z][a-z]*(?:[ '-][a-z]+)*$/.test(w);
  // Units (mL/kg/min → 毫升每公斤每分鐘, km/h) are said, not translated: not a path.
  const path = (/^[\w.-]+(?:\/[\w.-]+)+$/.test(w) && !isUnit(w)) || /^https?:/i.test(w);
  const numberWord = /^(?:one|two|three|four|five|six|seven|eight|nine|ten)$/i.test(w);
  return plainWord || path || numberWord;
}

/** Glossary entries that really change what is read aloud, longest term first. */
export function effectiveReadings(glossary: GlossaryEntry[]): GlossaryEntry[] {
  return glossary
    .filter((g) => g.term.trim() && g.reading && g.reading !== g.term && !isTranslationNotReading(g.term, g.reading))
    .sort((a, b) => b.term.length - a.term.length);
}

export function applyGlossaryReadings(text: string, glossary: GlossaryEntry[]): string {
  let out = text;
  for (const g of effectiveReadings(glossary)) out = out.replace(glossaryTermRegex(g.term), g.reading!);
  return out;
}
