import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { contentHash, type GlossaryEntry, type Language, type ScriptRevision } from "@lvs/shared";
import { derivePronunciationText, deriveSubtitleText } from "@lvs/pipeline";
import type { Db } from "../db/client.js";
import { toScriptRevision } from "../db/mappers.js";
import { scenes, scriptRevisions, type SceneRow } from "../db/schema.js";

export interface DerivedTexts {
  pronunciationText: string;
  subtitleText: string;
}

/**
 * Turns a user-edited script into the TTS text (glossary readings, spoken numbers/symbols)
 * and the on-screen subtitle text. `glossary` is the latest outline's glossary when known.
 */
export type DeriveTexts = (script: string, language: Language, glossary?: GlossaryEntry[]) => DerivedTexts;

/** Whitespace-only derivation; tests use it to keep fixtures literal. */
export const fallbackDeriveTexts: DeriveTexts = (script) => {
  const normalised = script.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { pronunciationText: normalised, subtitleText: normalised };
};

/** Default: the pipeline's deterministic text derivation. */
export const pipelineDeriveTexts: DeriveTexts = (script, language, glossary = []) => ({
  pronunciationText: derivePronunciationText(script, glossary, language),
  subtitleText: deriveSubtitleText(script),
});

/** Rough speaking-time guess used before audio exists (zh ≈ 4.2 chars/s, en ≈ 2.5 words/s). */
export function estimateSpeakingSeconds(text: string, language: Language): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const words = text.replace(/[㐀-鿿豈-﫿]/g, " ").split(/\s+/).filter(Boolean).length;
  const seconds = cjk / 4.2 + words / 2.5;
  return Math.round(Math.max(language === "en" ? 0 : 0, seconds) * 10) / 10;
}

export async function latestRevisionForScene(db: Db, sceneId: string): Promise<ScriptRevision | undefined> {
  const [row] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.sceneId, sceneId))
    .orderBy(desc(scriptRevisions.version))
    .limit(1);
  return row ? toScriptRevision(row) : undefined;
}

export interface CreateRevisionInput {
  scene: SceneRow;
  script: string;
  pronunciationText?: string;
  subtitleText?: string;
  source: ScriptRevision["source"];
  language: Language;
  outlineRevisionId?: string;
  /** Hash of the inputs that produced an AI script; for user scripts the hash of the text. */
  inputHash?: string;
  /** The job that wrote it: a retried 「全部重新產生」 skips pages it already finished. */
  jobId?: string;
  deriveTexts?: DeriveTexts;
  /** Glossary readings applied by `deriveTexts` (latest outline). */
  glossary?: GlossaryEntry[];
  estimatedDurationSec?: number;
}

/**
 * Appends a revision, points the scene at it, and marks audio/subtitle/avatar stale.
 * Returns the existing latest revision unchanged when the text is identical (autosave no-op).
 */
export async function createScriptRevision(db: Db, input: CreateRevisionInput): Promise<{ revision: ScriptRevision; created: boolean }> {
  const derive = input.deriveTexts ?? pipelineDeriveTexts;
  const derived = derive(input.script, input.language, input.glossary);
  const pronunciationText = input.pronunciationText ?? derived.pronunciationText;
  const subtitleText = input.subtitleText ?? derived.subtitleText;
  const latest = await latestRevisionForScene(db, input.scene.id);
  if (
    latest &&
    latest.script === input.script &&
    latest.pronunciationText === pronunciationText &&
    latest.subtitleText === subtitleText &&
    latest.source === input.source
  ) {
    // Saving the same hand-written text again confirms it still fits a slide that changed (deck
    // replaced): the page stops reading 需更新.
    if (input.source !== "ai" && input.scene.script.status === "stale") {
      await db.update(scenes).set({ script: { ...input.scene.script, status: "ready" } }).where(eq(scenes.id, input.scene.id));
    }
    return { revision: latest, created: false };
  }
  const version = (latest?.version ?? 0) + 1;
  const hash = contentHash({ script: input.script, pronunciationText, subtitleText, source: input.source });
  const [row] = await db
    .insert(scriptRevisions)
    .values({
      id: randomUUID(),
      sceneId: input.scene.id,
      version,
      script: input.script,
      pronunciationText,
      subtitleText,
      source: input.source,
      outlineRevisionId: input.outlineRevisionId ?? null,
      contentHash: hash,
      estimatedDurationSec: input.estimatedDurationSec ?? estimateSpeakingSeconds(pronunciationText, input.language),
    })
    .returning();
  const revision = toScriptRevision(row!);
  const stale = (prev: SceneRow["audio"]) => (prev.status === "missing" ? prev : { ...prev, status: "stale" as const });
  await db
    .update(scenes)
    .set({
      scriptRevisionId: revision.id,
      script: { status: "ready", inputHash: input.inputHash ?? hash, ...(input.jobId ? { jobId: input.jobId } : {}) },
      audio: stale(input.scene.audio),
      subtitle: stale(input.scene.subtitle),
      avatar: stale(input.scene.avatar),
    })
    .where(eq(scenes.id, input.scene.id));
  return { revision, created: true };
}
