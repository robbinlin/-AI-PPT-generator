import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { GlossaryEntry, Project, ScriptRevision } from "@lvs/shared";
import { cuesToSrt, retextCues } from "@lvs/pipeline";
import type { AppContext } from "../context.js";
import { toAsset, toScene } from "../db/mappers.js";
import { assets, scenes, type SceneRow } from "../db/schema.js";
import { audioInputHash, subtitleInputHash } from "../jobs/hashes.js";

/**
 * Only the on-screen text of a page changed (a typo in 字幕文本): the speech and the presenter clip
 * still fit, so they keep their state, and the page's cues are re-timed from the ones it has —
 * no new speech, no new (paid) presenter. Returns false when the edit is not subtitle-only or the
 * page has no current narration to time against; the page then stays 需更新 as before.
 */
export async function retextSubtitleOnly(
  ctx: Pick<AppContext, "db" | "storage" | "bus">,
  project: Pick<Project, "id" | "settings">,
  before: SceneRow,
  previous: ScriptRevision | undefined,
  revision: ScriptRevision,
  glossary: GlossaryEntry[] | undefined,
): Promise<boolean> {
  // What is spoken decides: a script tidied without changing the narration text keeps its speech too.
  if (!previous || previous.pronunciationText !== revision.pronunciationText) return false;
  if (previous.subtitleText === revision.subtitleText) return false;
  const cues = before.subtitle.cues ?? [];
  const settings = project.settings;
  const aHash = audioInputHash({ pronunciationText: revision.pronunciationText, settings, glossaryReadings: glossary });
  if (!cues.length || !before.audio.assetId || before.audio.inputHash !== aHash) return false;

  const durationSec = before.durationSec ?? cues.at(-1)!.endSec;
  const newCues = retextCues(cues, revision.subtitleText, { durationSec, maxCharsPerLine: settings.subtitles.style.maxCharsPerLine, language: settings.language });
  const sHash = subtitleInputHash({ audioInputHash: aHash, subtitleText: revision.subtitleText, settings });
  const key = `projects/${project.id}/scenes/${before.id}/subtitle-${sHash.slice(0, 12)}.srt`;
  const put = await ctx.storage.put(key, Buffer.from(cuesToSrt(newCues), "utf8"), "application/x-subrip");
  const [row] = await ctx.db
    .insert(assets)
    .values({
      id: randomUUID(),
      projectId: project.id,
      kind: "subtitle",
      storageKey: key,
      mimeType: "application/x-subrip",
      sizeBytes: put.sizeBytes,
      durationSec,
      inputHash: sHash,
      producedBy: {},
    })
    .returning();
  const asset = toAsset(row!);
  const [fresh] = await ctx.db
    .update(scenes)
    // createScriptRevision marked everything 需更新; the speech and presenter are the same as before.
    .set({ audio: before.audio, avatar: before.avatar, subtitle: { status: "ready", assetId: asset.id, inputHash: sHash, cues: newCues } })
    .where(eq(scenes.id, before.id))
    .returning();
  ctx.bus.publish(project.id, { kind: "asset", asset });
  if (fresh) ctx.bus.publish(project.id, { kind: "scene", scene: toScene(fresh) });
  return true;
}
