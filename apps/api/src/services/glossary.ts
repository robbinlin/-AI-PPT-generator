import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { GlossaryEntry, OutlineRevision, ProjectDetail, ScriptRevision } from "@lvs/shared";
import type { AppContext } from "../context.js";
import { toOutline, toScene } from "../db/mappers.js";
import { outlineRevisions, scenes } from "../db/schema.js";
import { conflict } from "../errors.js";
import { audioInputHash, subtitleInputHash } from "../jobs/hashes.js";
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
  const changed = changedTerms(previous.glossary, next);
  const settings = detail.project.settings;

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
      inputHash: previous.inputHash,
    })
    .returning();
  const outline = toOutline(row!);
  ctx.bus.publish(projectId, { kind: "outline", outline });

  const uses = (rev: ScriptRevision) => changed.some((term) => rev.script.includes(term));
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
        outlineRevisionId: outline.id,
        inputHash: sceneRow.script.inputHash,
        estimatedDurationSec: rev.estimatedDurationSec,
      });
      if (created) {
        affectedSceneIds.push(scene.id);
        ctx.bus.publish(projectId, { kind: "script", script: revision });
      }
    } else {
      // Same words spoken: carry finished audio and subtitles over to the new glossary's hashes.
      const set: Partial<typeof scenes.$inferInsert> = {};
      const aHash = audioInputHash({ pronunciationText: rev.pronunciationText, settings, glossaryReadings: next });
      if (scene.audio.status === "ready") set.audio = { ...sceneRow.audio, status: "ready", inputHash: aHash };
      if (scene.subtitle.status === "ready") {
        set.subtitle = { ...sceneRow.subtitle, status: "ready", inputHash: subtitleInputHash({ audioInputHash: aHash, subtitleText: rev.subtitleText, settings }) };
      }
      if (Object.keys(set).length === 0) continue;
      await db.update(scenes).set(set).where(eq(scenes.id, scene.id));
    }
    const [fresh] = await db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
    if (fresh) ctx.bus.publish(projectId, { kind: "scene", scene: toScene(fresh) });
  }
  return { outline, affectedSceneIds };
}
