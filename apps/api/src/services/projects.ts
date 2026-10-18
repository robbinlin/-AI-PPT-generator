import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Asset, Job, OutlineRevision, ProjectDetail, Scene, ScriptRevision, Slide, SourceDocument } from "@lvs/shared";
import type { Db } from "../db/client.js";
import { toAsset, toJob, toOutline, toProject, toScene, toScriptRevision, toSlide, toSourceDocument } from "../db/mappers.js";
import { assets, jobs, outlineRevisions, projects, scenes, scriptRevisions, slides, sourceDocuments } from "../db/schema.js";
import { notFound } from "../errors.js";
import { audioInputHash, effectiveStatus, outlineInputHash, scriptInputHash, subtitleInputHash, avatarInputHash } from "../jobs/hashes.js";

export async function requireProject(db: Db, ownerId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound("project", projectId);
  return row;
}

export async function latestSourceDocument(db: Db, projectId: string): Promise<SourceDocument | undefined> {
  const [row] = await db
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.projectId, projectId))
    .orderBy(desc(sourceDocuments.version))
    .limit(1);
  return row ? toSourceDocument(row) : undefined;
}

export async function listSlidesInOrder(db: Db, projectId: string): Promise<Slide[]> {
  const rows = await db.select().from(slides).where(eq(slides.projectId, projectId)).orderBy(asc(slides.index));
  return rows.map(toSlide);
}

export async function listScenesInOrder(db: Db, projectId: string): Promise<Scene[]> {
  const rows = await db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.index));
  return rows.map(toScene);
}

/** Latest script revision per scene. */
export async function latestScripts(db: Db, sceneIds: string[]): Promise<Record<string, ScriptRevision>> {
  if (sceneIds.length === 0) return {};
  const rows = await db
    .select()
    .from(scriptRevisions)
    .where(inArray(scriptRevisions.sceneId, sceneIds))
    .orderBy(desc(scriptRevisions.version));
  const out: Record<string, ScriptRevision> = {};
  for (const r of rows) if (!out[r.sceneId]) out[r.sceneId] = toScriptRevision(r);
  return out;
}

export async function latestOutline(db: Db, projectId: string): Promise<OutlineRevision | undefined> {
  const [row] = await db
    .select()
    .from(outlineRevisions)
    .where(eq(outlineRevisions.projectId, projectId))
    .orderBy(desc(outlineRevisions.version))
    .limit(1);
  return row ? toOutline(row) : undefined;
}

export async function activeJobs(db: Db, projectId: string): Promise<Job[]> {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ["queued", "running"])))
    .orderBy(asc(jobs.createdAt));
  return rows.map(toJob);
}

/**
 * Recompute `stale` flags from current inputs so the editor always shows truth without the
 * job runner having to touch every scene on each settings change.
 */
export function withEffectiveStatuses(
  scenesInOrder: Scene[],
  slidesById: Map<string, Slide>,
  scripts: Record<string, ScriptRevision>,
  outline: OutlineRevision | undefined,
  settings: ProjectDetail["project"]["settings"],
): Scene[] {
  const orderedSlides = scenesInOrder.map((s) => slidesById.get(s.slideId)).filter((s): s is Slide => !!s);
  const outlineHash = outlineInputHash(orderedSlides, settings);
  return scenesInOrder.map((scene, i) => {
    const slide = slidesById.get(scene.slideId);
    if (!slide) return scene;
    const script = scripts[scene.id];
    const scriptHash = scriptInputHash({
      slide,
      prev: orderedSlides[i - 1],
      next: orderedSlides[i + 1],
      outlineInputHash: outline?.inputHash ?? outlineHash,
      settings,
    });
    const out: Scene = { ...scene };
    // A user-authored script is never stale because of upstream changes; AI scripts are.
    if (script?.source === "ai") out.script = { ...scene.script, status: effectiveStatus(scene.script, scriptHash) };
    if (script) {
      const aHash = audioInputHash({
        pronunciationText: script.pronunciationText,
        settings,
        glossaryReadings: outline?.glossary,
      });
      out.audio = { ...scene.audio, status: effectiveStatus(scene.audio, aHash) };
      const sHash = subtitleInputHash({ audioInputHash: aHash, subtitleText: script.subtitleText, settings });
      out.subtitle = { ...scene.subtitle, status: effectiveStatus(scene.subtitle, sHash) };
      if (scene.audio.assetId) {
        const vHash = avatarInputHash({ audioAssetId: scene.audio.assetId, settings });
        out.avatar = { ...scene.avatar, status: effectiveStatus(scene.avatar, vHash) };
      }
      if (out.audio.status === "stale") {
        if (out.subtitle.status === "ready") out.subtitle = { ...out.subtitle, status: "stale" };
        if (out.avatar.status === "ready") out.avatar = { ...out.avatar, status: "stale" };
      }
    }
    return out;
  });
}

export async function getProjectDetail(db: Db, ownerId: string, projectId: string): Promise<ProjectDetail> {
  const projectRow = await requireProject(db, ownerId, projectId);
  const [sourceDocument, slideList, sceneList, outline, active] = await Promise.all([
    latestSourceDocument(db, projectId),
    listSlidesInOrder(db, projectId),
    listScenesInOrder(db, projectId),
    latestOutline(db, projectId),
    activeJobs(db, projectId),
  ]);
  const project = { ...toProject(projectRow), pageCount: sourceDocument?.pageCount };
  const scripts = await latestScripts(
    db,
    sceneList.map((s) => s.id),
  );
  const slidesById = new Map(slideList.map((s) => [s.id, s]));
  const sceneListEffective = withEffectiveStatuses(sceneList, slidesById, scripts, outline, project.settings);

  const assetIds = new Set<string>();
  for (const s of slideList) {
    if (s.imageAssetId) assetIds.add(s.imageAssetId);
    if (s.thumbnailAssetId) assetIds.add(s.thumbnailAssetId);
  }
  for (const s of sceneList) {
    for (const st of [s.audio, s.avatar, s.subtitle]) if (st.assetId) assetIds.add(st.assetId);
  }
  const assetMap: Record<string, Asset> = {};
  if (assetIds.size > 0) {
    const rows = await db.select().from(assets).where(inArray(assets.id, [...assetIds]));
    for (const r of rows) assetMap[r.id] = toAsset(r);
  }
  // Project-level outputs (rendered video, whole-video SRT, script exports) are not referenced
  // by any scene; include the newest of each kind so the editor can offer downloads.
  const outputRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), inArray(assets.kind, ["video", "script_export"])))
    .orderBy(desc(assets.createdAt));
  const seenKinds = new Set<string>();
  for (const r of outputRows) {
    if (seenKinds.has(r.kind)) continue;
    seenKinds.add(r.kind);
    assetMap[r.id] = toAsset(r);
  }
  // The global SRT written by the last render sits next to the video; find it via the render job result.
  const lastRender = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "render_video"), eq(jobs.status, "succeeded")))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  const srtId = (lastRender[0]?.result as { srtAssetId?: string } | null)?.srtAssetId;
  if (srtId && !assetMap[srtId]) {
    const [srt] = await db.select().from(assets).where(eq(assets.id, srtId));
    if (srt) assetMap[srt.id] = toAsset(srt);
  }

  let totalDurationSec = 0;
  for (const s of sceneListEffective) {
    const slide = slidesById.get(s.slideId);
    if (slide?.hidden) continue;
    const d = s.durationSec ?? scripts[s.id]?.estimatedDurationSec ?? 0;
    totalDurationSec += d + (d > 0 ? s.tailPauseSec : 0);
  }

  return {
    project,
    sourceDocument,
    slides: slideList,
    scenes: sceneListEffective,
    scripts,
    outline,
    assets: assetMap,
    activeJobs: active,
    totalDurationSec: Math.round(totalDurationSec * 100) / 100,
  };
}
