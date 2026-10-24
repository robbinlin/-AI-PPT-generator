import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Job, Language, Project, ProjectSettings } from "@lvs/shared";
import { ProjectSettings as ProjectSettingsSchema } from "@lvs/shared";
import type { AppContext } from "../context.js";
import { toProject } from "../db/mappers.js";
import { assets, projects, scenes, slides, sourceDocuments } from "../db/schema.js";
import { conflict } from "../errors.js";
import { requireProject } from "./projects.js";

const LANGUAGE_SUFFIX: Record<Language, string> = { en: "英文版", "zh-TW": "中文版", mixed: "中英版" };

export function translatedName(name: string, language: Language): string {
  return `${name}（${LANGUAGE_SUFFIX[language]}）`;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * A copy of `sourceId` in another language: same deck (the slide images and the uploaded file are
 * copied under the new project's own keys, so deleting either project leaves the other intact),
 * same settings, voice and layout, page order, hidden/muted pages and tail pauses — but no scripts,
 * audio or avatars. A `translate_script` job then fills the scripts from the source project.
 */
export async function createTranslatedProject(
  ctx: Pick<AppContext, "db" | "storage" | "runner">,
  ownerId: string,
  sourceId: string,
  language: Language,
  name?: string,
): Promise<{ project: Project; job: Job }> {
  const { db, storage } = ctx;
  const source = await requireProject(db, ownerId, sourceId);
  const [doc] = await db.select().from(sourceDocuments).where(eq(sourceDocuments.projectId, sourceId)).orderBy(desc(sourceDocuments.version)).limit(1);
  const srcSlides = await db.select().from(slides).where(eq(slides.projectId, sourceId)).orderBy(asc(slides.index));
  if (!doc || srcSlides.length === 0) throw conflict("這個專案還沒有投影片，請先上傳簡報");
  const srcScenes = await db.select().from(scenes).where(eq(scenes.projectId, sourceId)).orderBy(asc(scenes.index));
  const imageIds = srcSlides.flatMap((s) => [s.imageAssetId, s.thumbnailAssetId]).filter((id): id is string => !!id);
  const srcAssets = new Map((imageIds.length ? await db.select().from(assets).where(inArray(assets.id, imageIds)) : []).map((a) => [a.id, a]));

  const projectId = randomUUID();
  const docId = randomUUID();
  const settings: ProjectSettings = ProjectSettingsSchema.parse({ ...(source.settings as ProjectSettings), language });

  // Files first (outside the transaction): copy the upload and every slide image/thumbnail.
  const docKey = `projects/${projectId}/source/${docId}/${doc.filename}`;
  await storage.put(docKey, await readAll((await storage.getStream(doc.storageKey)).stream), doc.mimeType);
  const assetCopies = new Map<string, typeof assets.$inferInsert>();
  for (const s of srcSlides) {
    for (const id of [s.imageAssetId, s.thumbnailAssetId]) {
      const a = id ? srcAssets.get(id) : undefined;
      if (!a) continue;
      const file = a.storageKey.split("/").at(-1)!;
      const key = `projects/${projectId}/slides/${docId}/${file}`;
      await storage.put(key, await readAll((await storage.getStream(a.storageKey)).stream), a.mimeType);
      assetCopies.set(a.id, { ...a, id: randomUUID(), projectId, storageKey: key, producedBy: {}, createdAt: undefined });
    }
  }

  const row = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ id: projectId, ownerId, name: name ?? translatedName(source.name, language), settings })
      .returning();
    await tx.insert(sourceDocuments).values({ ...doc, id: docId, projectId, storageKey: docKey, parseJobId: null, createdAt: undefined });
    if (assetCopies.size) await tx.insert(assets).values([...assetCopies.values()]);
    const slideIdMap = new Map<string, string>();
    for (const s of srcSlides) {
      const id = randomUUID();
      slideIdMap.set(s.id, id);
      await tx.insert(slides).values({
        ...s,
        id,
        projectId,
        sourceDocumentId: docId,
        imageAssetId: s.imageAssetId ? (assetCopies.get(s.imageAssetId)?.id ?? null) : null,
        thumbnailAssetId: s.thumbnailAssetId ? (assetCopies.get(s.thumbnailAssetId)?.id ?? null) : null,
      });
    }
    const empty = { status: "missing" as const };
    for (const sc of srcScenes) {
      const slideId = slideIdMap.get(sc.slideId);
      if (!slideId) continue;
      await tx.insert(scenes).values({
        id: randomUUID(),
        projectId,
        slideId,
        index: sc.index,
        muted: sc.muted,
        avatarLayout: sc.avatarLayout,
        transitionIn: sc.transitionIn,
        tailPauseSec: sc.tailPauseSec,
        script: empty,
        audio: empty,
        avatar: empty,
        subtitle: empty,
      });
    }
    return p!;
  });

  const job = await ctx.runner.enqueue(projectId, { type: "translate_script", sourceProjectId: sourceId, targetLanguage: language });
  return { project: toProject(row), job };
}
