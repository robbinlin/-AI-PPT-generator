import { usesGlossaryTerm } from "@lvs/shared";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { GlossaryEntry, OutlineRevision, ProjectDetail, ProjectEvent, ScriptRevision } from "@lvs/shared";
import type { AppContext } from "../context.js";
import { toOutline, toScene } from "../db/mappers.js";
import { outlineRevisions, scenes } from "../db/schema.js";
import { conflict } from "../errors.js";
import { audioInputHash, subtitleBuiltWidth, subtitleInputHash } from "../jobs/hashes.js";
import { getProjectDetail } from "./projects.js";
import { createScriptRevision, pipelineDeriveTexts } from "./scripts.js";

const normalise = (g: GlossaryEntry[]): GlossaryEntry[] =>
  g
    .map((e) => ({
      term: e.term.trim(),
      ...(e.reading?.trim() ? { reading: e.reading.trim() } : {}),
      ...(e.definition?.trim() ? { definition: e.definition.trim() } : {}),
    }))
    .filter((e) => e.term);

/** Terms whose reading was added, changed or removed. */
export function changedTerms(before: GlossaryEntry[], after: GlossaryEntry[]): string[] {
  const reading = (list: GlossaryEntry[]) => new Map(list.map((e) => [e.term, e.reading ?? ""]));
  const a = reading(before);
  const b = reading(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((term) => (a.get(term) ?? "") !== (b.get(term) ?? ""));
}

/**
 * The user corrects how glossary terms are read aloud (「VO → 攝氧」 was wrong). Saves a new outline
 * revision with the same input hash (the plan itself did not change, so AI scripts stay current),
 * re-derives the narration text of the pages that use a changed term (their audio becomes 需更新),
 * and re-stamps every other page's audio/subtitle hash so they stay ready: nothing they say changed.
 */
export async function updateGlossary(
  ctx: Pick<AppContext, "db" | "bus" | "deriveTexts">,
  ownerId: string,
  projectId: string,
  glossary: GlossaryEntry[],
): Promise<{ outline: OutlineRevision; affectedSceneIds: string[] }> {
  const { db } = ctx;
  const detail: ProjectDetail = await getProjectDetail(db, ownerId, projectId);
  const previous = detail.outline;
  if (!previous) throw conflict("還沒有大綱，請先產生大綱");
  const next = normalise(glossary);
  const [prevRow] = await db.select({ removedTerms: outlineRevisions.removedTerms }).from(outlineRevisions).where(eq(outlineRevisions.id, previous.id)).limit(1);
  const previousRemoved = prevRow?.removedTerms;

  const [row] = await db
    .insert(outlineRevisions)
    .values({
      id: randomUUID(),
      projectId,
      version: previous.version + 1,
      objectives: previous.objectives,
      summary: previous.summary,
      sections: previous.sections,
      glossary: next,
      timeAllocation: previous.timeAllocation,
      // Deleted here (and not added back): a new plan must not bring them back.
      removedTerms: [
        ...new Set([...(previousRemoved ?? []), ...previous.glossary.map((e) => e.term).filter((term) => !next.some((e) => e.term === term))]),
      ].filter((term) => !next.some((e) => e.term === term)),
      inputHash: previous.inputHash,
    })
    .returning();
  const outline = toOutline(row!);
  ctx.bus.publish(projectId, { kind: "outline", outline });
  const affectedSceneIds = await applyGlossaryChange(
    { db, deriveTexts: ctx.deriveTexts, publish: (e) => ctx.bus.publish(projectId, e) },
    detail,
    previous.glossary,
    next,
    outline.id,
  );
  return { outline, affectedSceneIds };
}

/**
 * A new outline (re-planned by AI) keeps how every known term is read: a term in both keeps its old
 * reading — or none, when the lecturer cleared it so it is spelled out — and a term the new plan
 * dropped that had a reading stays. Only terms new to the glossary take the AI's reading.
 */
export function mergeGlossary(
  previous: GlossaryEntry[],
  next: GlossaryEntry[],
  /** Terms the lecturer deleted (in an earlier outline, not in the current one): not added back. */
  removed: ReadonlySet<string> = new Set(),
): GlossaryEntry[] {
  const old = new Map(previous.map((e) => [e.term, e]));
  const merged = next.filter((e) => old.has(e.term) || !removed.has(e.term)).map((e) => {
    const was = old.get(e.term);
    if (!was) return e;
    const { reading: _ai, ...rest } = e;
    return was.reading ? { ...rest, reading: was.reading } : rest;
  });
  const kept = new Set(merged.map((e) => e.term));
  return [...merged, ...previous.filter((e) => e.reading && !kept.has(e.term))];
}

/**
 * After the glossary changed (edited, or a new outline): pages that use a changed term get their
 * narration re-derived (their audio becomes 需更新); every other page's finished audio/subtitles are
 * re-stamped to the new glossary's hashes, since nothing they say changed. Returns the re-derived pages.
 */
export async function applyGlossaryChange(
  ctx: { db: AppContext["db"]; deriveTexts?: AppContext["deriveTexts"]; publish: (e: ProjectEvent) => void },
  detail: ProjectDetail,
  before: GlossaryEntry[],
  next: GlossaryEntry[],
  outlineRevisionId: string,
): Promise<string[]> {
  const { db } = ctx;
  const changed = changedTerms(before, next);
  const settings = detail.project.settings;
  const uses = (rev: ScriptRevision) => changed.some((term) => usesGlossaryTerm(rev.script, term));
  const affectedSceneIds: string[] = [];
  for (const scene of detail.scenes) {
    const rev = detail.scripts[scene.id];
    if (!rev) continue;
    const [sceneRow] = await db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
    if (!sceneRow) continue;
    const pronunciationText = changed.length && uses(rev) ? (ctx.deriveTexts ?? pipelineDeriveTexts)(rev.script, settings.language, next).pronunciationText : rev.pronunciationText;
    if (pronunciationText !== rev.pronunciationText) {
      const { revision, created } = await createScriptRevision(db, {
        scene: sceneRow,
        script: rev.script,
        pronunciationText,
        subtitleText: rev.subtitleText,
        source: rev.source,
        language: settings.language,
        outlineRevisionId,
        inputHash: sceneRow.script.inputHash,
        estimatedDurationSec: rev.estimatedDurationSec,
      });
      if (created) {
        affectedSceneIds.push(scene.id);
        ctx.publish({ kind: "script", script: revision });
      }
    } else {
      // Same words spoken: carry finished audio and subtitles over to the new glossary's hashes.
      const set: Partial<typeof scenes.$inferInsert> = {};
      const aHash = audioInputHash({ pronunciationText: rev.pronunciationText, settings, glossaryReadings: next });
      if (scene.audio.status === "ready") set.audio = { ...sceneRow.audio, status: "ready", inputHash: aHash };
      if (scene.subtitle.status === "ready") {
        // Keep the line width the cues were actually built with (a width change since is re-wrapped
        // at export): stamping today's width would make the export use the old wrapping as-is.
        const built =
          subtitleBuiltWidth({ subtitleInputHash: sceneRow.subtitle.inputHash, audioInputHash: sceneRow.audio.inputHash, subtitleText: rev.subtitleText, settings }) ??
          settings.subtitles.style.maxCharsPerLine;
        const asBuilt = { ...settings, subtitles: { ...settings.subtitles, style: { ...settings.subtitles.style, maxCharsPerLine: built } } };
        set.subtitle = { ...sceneRow.subtitle, status: "ready", inputHash: subtitleInputHash({ audioInputHash: aHash, subtitleText: rev.subtitleText, settings: asBuilt }) };
      }
      if (Object.keys(set).length === 0) continue;
      await db.update(scenes).set(set).where(eq(scenes.id, scene.id));
    }
    const [fresh] = await db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
    if (fresh) ctx.publish({ kind: "scene", scene: toScene(fresh) });
  }
  return affectedSceneIds;
}
