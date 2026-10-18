import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { contentHash, type Language, type ScriptRevision } from "@lvs/shared";
import type { Db } from "../db/client.js";
import { toScriptRevision } from "../db/mappers.js";
import { scenes, scriptRevisions, type SceneRow } from "../db/schema.js";

export interface DerivedTexts {
  pronunciationText: string;
  subtitleText: string;
}

/**
 * Integration seam: @lvs/pipeline will provide a real implementation (symbol → reading,
 * number normalisation, glossary readings). This fallback only normalises whitespace.
 */
export type DeriveTexts = (script: string, language: Language) => DerivedTexts;

export const fallbackDeriveTexts: DeriveTexts = (script) => {
  const normalised = script.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { pronunciationText: normalised, subtitleText: normalised };
};

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
  source: "ai" | "user";
  language: Language;
  outlineRevisionId?: string;
  /** Hash of the inputs that produced an AI script; for user scripts the hash of the text. */
  inputHash?: string;
  deriveTexts?: DeriveTexts;
}

/**
 * Appends a revision, points the scene at it, and marks audio/subtitle/avatar stale.
 * Returns the existing latest revision unchanged when the text is identical (autosave no-op).
 */
export async function createScriptRevision(db: Db, input: CreateRevisionInput): Promise<{ revision: ScriptRevision; created: boolean }> {
  const derive = input.deriveTexts ?? fallbackDeriveTexts;
  const derived = derive(input.script, input.language);
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
      estimatedDurationSec: estimateSpeakingSeconds(pronunciationText, input.language),
    })
    .returning();
  const revision = toScriptRevision(row!);
  const stale = (prev: SceneRow["audio"]) => (prev.status === "missing" ? prev : { ...prev, status: "stale" as const });
  await db
    .update(scenes)
    .set({
      scriptRevisionId: revision.id,
      script: { status: "ready", inputHash: input.inputHash ?? hash },
      audio: stale(input.scene.audio),
      subtitle: stale(input.scene.subtitle),
      avatar: stale(input.scene.avatar),
    })
    .where(eq(scenes.id, input.scene.id));
  return { revision, created: true };
}
