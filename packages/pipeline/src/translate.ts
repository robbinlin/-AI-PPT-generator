import { z } from "zod";
import type { GlossaryEntry, Language, LlmProvider, ProjectSettings, UsageDelta } from "@lvs/shared";
import { describeLanguage } from "./prompts.js";
import { derivePronunciationText, deriveSubtitleText, estimateSpeakingSeconds } from "./texts.js";

export const TranslationLlmOutput = z.object({ script: z.string() });

export interface TranslateSceneScriptInput {
  llm: LlmProvider;
  /** The page's narration in the source language. */
  script: string;
  from: Language;
  to: Language;
  pageNumber: number;
  pageCount: number;
  /** Deck title, for context. */
  title?: string;
  /** Source-language narration of the pages around this one (context only, not translated). */
  previousScript?: string;
  nextScript?: string;
  /** Source-language terms (with their definitions) whose translation must stay consistent. */
  glossary?: GlossaryEntry[];
}

export interface TranslateSceneScriptResult {
  script: string;
  pronunciationText: string;
  subtitleText: string;
  estimatedDurationSec: number;
  usage: UsageDelta[];
}

/** Marker the dev-mode mock LLM uses to recognise a translation prompt. */
export const TRANSLATION_PROMPT_HEADING = "## Narration to translate";

export function buildTranslatePrompt(input: Omit<TranslateSceneScriptInput, "llm">): { system: string; prompt: string } {
  const target = describeLanguage({ language: input.to } as ProjectSettings);
  const system = [
    `You translate the spoken narration of a university lecture video into ${target}.`,
    "The text will be read aloud by a text-to-speech voice and shown as subtitles, so write natural spoken language a lecturer would say, not a literal or written-style translation.",
    "Keep every fact, number, example and the order of ideas. Do not add, drop or summarise content, and do not add greetings that are not in the source.",
    "Use the standard terms of the subject in the target language; keep a technical term's established abbreviation (e.g. VO2max, ANOVA) when the source uses it.",
    "Write numbers, units and statistics the way a lecturer says them in the target language.",
    "Translate the same source term the same way every time; the glossary lists the terms of this lecture.",
    'Return JSON: {"script": "<the translated narration>"} and nothing else.',
  ].join("\n");
  const parts: string[] = [];
  if (input.title) parts.push(`## Lecture\n${input.title}`);
  parts.push(`## Position\nPage ${input.pageNumber} of ${input.pageCount}.`);
  const terms = (input.glossary ?? []).filter((g) => g.term.trim());
  if (terms.length) {
    parts.push(`## Glossary (source terms)\n${terms.map((g) => `- ${g.term}${g.definition ? `: ${g.definition}` : ""}`).join("\n")}`);
  }
  if (input.previousScript?.trim()) parts.push(`## Previous page narration (context only, do not translate)\n${input.previousScript.trim()}`);
  if (input.nextScript?.trim()) parts.push(`## Next page narration (context only, do not translate)\n${input.nextScript.trim()}`);
  parts.push(`${TRANSLATION_PROMPT_HEADING}\n${input.script.trim()}`);
  return { system, prompt: parts.join("\n\n") };
}

/**
 * Translates one page's narration (zh-TW → en, typically) with its neighbours as context, then
 * derives the spoken and subtitle texts for the target language like a written script.
 */
export async function translateSceneScript(input: TranslateSceneScriptInput): Promise<TranslateSceneScriptResult> {
  const { system, prompt } = buildTranslatePrompt(input);
  const usage: UsageDelta[] = [];
  const ask = async (sys: string) => {
    // The fast model, like script writing: the default (thinking) model took ~2 min a page.
    const res = await input.llm.generateJson({ system: sys, prompt, schema: TranslationLlmOutput, temperature: 0.2, reasoning: "none" });
    usage.push(...res.usage);
    return res.data.script.replace(/\r\n?/g, "\n").trim();
  };
  let script = await ask(system);
  // Seen on 2026-10-27: 2 of 18 chapter-6 pages came back as the Chinese source, unchanged.
  if (script && !inTargetLanguage(script, input.to)) {
    const target = describeLanguage({ language: input.to } as ProjectSettings);
    script = await ask(`${system}\nYour previous answer repeated the source text. Write the whole narration in ${target}.`);
  }
  if (!script) throw new Error("model returned an empty translation");
  if (!inTargetLanguage(script, input.to)) throw new Error("model returned the narration untranslated");
  return {
    script,
    // Source-language glossary readings must not leak into the target speech.
    pronunciationText: derivePronunciationText(script, [], input.to),
    subtitleText: deriveSubtitleText(script),
    estimatedDurationSec: Math.round(estimateSpeakingSeconds(script, input.to) * 10) / 10,
    usage,
  };
}

/** Rough script check: English narration is mostly free of Chinese characters, Chinese narration has them. */
export function inTargetLanguage(text: string, to: Language): boolean {
  const letters = text.replace(/[\s\p{P}\p{S}\d]/gu, "");
  if (!letters) return true;
  const han = (letters.match(/\p{Script=Han}/gu) ?? []).length / letters.length;
  // An echoed source is ~90% Han; an English line may still quote a Chinese term or two.
  return to === "en" ? han < 0.5 : han > 0.3;
}
