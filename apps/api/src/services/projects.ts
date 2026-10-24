import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Asset, Job, OutlineRevision, ProjectDetail, Scene, ScriptRevision, Slide, SourceDocument } from "@lvs/shared";
import type { Db } from "../db/client.js";
import { toAsset, toJob, toOutline, toProject, toScene, toScriptRevision, toSlide, toSourceDocument } from "../db/mappers.js";
import { assets, jobs, outlineRevisions, projects, scenes, scriptRevisions, slides, sourceDocuments } from "../db/schema.js";
import { notFound } from "../errors.js";
import {
  audioInputHash,
  avatarInputHash,
  effectiveStatus,
  outlineInputHash,
  renderInputHash,
  scriptInputHash,
  subtitleInputHash,
} from "../jobs/hashes.js";

/** Render variants the editor can produce; `currentRenderHashes` covers each of them. */
export const RENDER_PRESETS = ["preview_540p", "hd_1080p"] as const;

/**
 * Render input hashes the project would produce right now, computed exactly like the
 * render_video handler does (visible scenes in order, current settings).
 */
export function currentRenderHashes(scenesInOrder: Scene[], slidesById: Map<string, Slide>, settings: ProjectDetail["project"]["settings"]): string[] {
  const visible = scenesInOrder.filter((sc) => !slidesById.get(sc.slideId)?.hidden);
  const out: string[] = [];
  for (const preset of RENDER_PRESETS) {
    for (const burnSubtitles of [true, false]) out.push(renderInputHash({ scenesInOrder: visible, settings, preset, burnSubtitles }));
  }
  return out;
}

/**
 * List-page extras for many projects at once (two queries, no N+1): page count of the latest
 * source document and the image of the first visible page.
 */
export async function projectListExtras(db: Db, projectIds: string[]): Promise<Map<string, { pageCount?: number; activePageCount?: number; thumbnailAssetId?: string }>> {
  const out = new Map<string, { pageCount?: number; activePageCount?: number; thumbnailAssetId?: string }>();
  if (projectIds.length === 0) return out;
  const [docRows, slideRows] = await Promise.all([
    db
      .select({ projectId: sourceDocuments.projectId, version: sourceDocuments.version, pageCount: sourceDocuments.pageCount })
      .from(sourceDocuments)
      .where(inArray(sourceDocuments.projectId, projectIds))
      .orderBy(desc(sourceDocuments.version)),
    db
      .select({ projectId: slides.projectId, imageAssetId: slides.imageAssetId, thumbnailAssetId: slides.thumbnailAssetId })
      .from(slides)
      .where(and(inArray(slides.projectId, projectIds), eq(slides.hidden, false)))
      .orderBy(asc(slides.index)),
  ]);
  for (const id of projectIds) out.set(id, {});
  const seenDoc = new Set<string>();
  for (const d of docRows) {
    if (seenDoc.has(d.projectId)) continue;
    seenDoc.add(d.projectId);
    out.get(d.projectId)!.pageCount = d.pageCount ?? undefined;
  }
  for (const sl of slideRows) {
    const e = out.get(sl.projectId)!;
    e.activePageCount = (e.activePageCount ?? 0) + 1;
    if (e.thumbnailAssetId) continue;
    const id = sl.thumbnailAssetId ?? sl.imageAssetId;
    if (id) e.thumbnailAssetId = id;
  }
  return out;
}

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
  // Scripts are written with their *visible* neighbours (generate_script): compare the same way, or
  // a page next to a hidden one reads 需更新 forever, even right after an AI rewrite.
  const visibleSlides = orderedSlides.filter((s) => !s.hidden);
  return scenesInOrder.map((scene) => {
    const slide = slidesById.get(scene.slideId);
    if (!slide) return scene;
    const script = scripts[scene.id];
    const pos = visibleSlides.findIndex((s) => s.id === slide.id);
    const scriptHash = scriptInputHash({
      slide,
      prev: pos > 0 ? visibleSlides[pos - 1] : undefined,
      next: pos >= 0 ? visibleSlides[pos + 1] : undefined,
      outlineInputHash: outline?.inputHash ?? outlineHash,
      settings,
    });
    const out: Scene = { ...scene };
    // A user-authored or translated script is never stale because of upstream changes; AI scripts are.
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
      // Only 「每行字數上限」 changed (same audio and text): the export re-wraps the cues for free,
      // so the subtitles count as current rather than asking for new speech.
      if (out.subtitle.status === "stale" && out.audio.status === "ready" && scene.subtitle.cues?.length && scene.subtitle.inputHash) {
        const stored = scene.subtitle.inputHash;
        const onlyWidth = Array.from({ length: 75 }, (_, k) => k + 6).some(
          (m) => subtitleInputHash({ audioInputHash: aHash, subtitleText: script.subtitleText, settings: { ...settings, subtitles: { ...settings.subtitles, style: { ...settings.subtitles.style, maxCharsPerLine: m } } } }) === stored,
        );
        if (onlyWidth) out.subtitle = { ...out.subtitle, status: "ready" };
      }
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
  const firstVisible = slideList.find((s) => !s.hidden);
  const thumbnailAssetId = firstVisible?.thumbnailAssetId ?? firstVisible?.imageAssetId;
  const project = { ...toProject(projectRow), pageCount: sourceDocument?.pageCount, ...(thumbnailAssetId ? { thumbnailAssetId } : {}) };
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
    // Muted pages hold for MUTED_SCENE_SEC (generation.ts) whatever audio they once had.
    const d = s.muted ? 3 : (s.durationSec ?? scripts[s.id]?.estimatedDurationSec ?? 0);
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
    currentRenderHashes: currentRenderHashes(sceneListEffective, slidesById, project.settings),
  };
}
