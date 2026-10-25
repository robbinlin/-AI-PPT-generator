import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { sha256Hex, SlideContent, type ParserManifest, type SceneAssetState } from "@lvs/shared";
import { toScene, toSlide } from "../../db/mappers.js";
import { assets, scenes, scriptRevisions, slides, sourceDocuments, type SceneRow, type SlideRow } from "../../db/schema.js";
import { NonRetryableJobError } from "../../errors.js";
import type { JobHandler } from "../context.js";
import { abortedByShutdown, throwIfAborted } from "../context.js";

export const slideContentHash = (plainText: string, notes: string | undefined) => sha256Hex(`${plainText}\n${notes ?? ""}`);

type ParsedPage = {
  pageNumber: number;
  content: SlideContent;
  contentHash: string;
  image: { buffer: Buffer; width: number; height: number };
  thumbnail: { buffer: Buffer };
};

/**
 * parse_document: runs the parser worker on the uploaded deck, stores page images as
 * assets, (re)creates slides, and matches scenes so existing scripts survive a re-upload.
 */
export const parseDocument: JobHandler<{ type: "parse_document"; sourceDocumentId: string }> = async (ctx) => {
  const { db, storage, job } = ctx;
  const docId = job.payload.sourceDocumentId;
  const [doc] = await db.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1);
  if (!doc) throw new NonRetryableJobError(`找不到上傳的簡報檔（${docId}），請重新上傳`);
  await db.update(sourceDocuments).set({ parseStatus: "running", parseJobId: job.id }).where(eq(sourceDocuments.id, docId));

  const scratch = await mkdtemp(join(tmpdir(), "lvs-parse-"));
  try {
    await ctx.emit(0.02, "準備檔案");
    const inputPath = join(scratch, `input.${doc.kind}`);
    const src = await storage.getStream(doc.storageKey);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(inputPath, await streamToBuffer(src.stream));
    throwIfAborted(ctx.signal);

    const outDir = join(scratch, "out");
    await ctx.emit(0.05, "解析文件");
    const manifest = await ctx.parserRunner.run({
      filePath: inputPath,
      outDir,
      kind: doc.kind as "pptx" | "ppt" | "pdf",
      signal: ctx.signal,
      onProgress: (f, m) => void ctx.emit(0.05 + f * 0.6, m ?? "解析文件"),
    });
    throwIfAborted(ctx.signal);

    const pages = await loadPages(manifest, outDir);
    await ctx.emit(0.7, `儲存 ${pages.length} 頁影像`);

    const projectId = doc.projectId;
    const prefix = `projects/${projectId}/slides/${docId}`;
    const created: Array<{ page: ParsedPage; imageAssetId: string; thumbnailAssetId: string; imageHash: string }> = [];
    for (const page of pages) {
      throwIfAborted(ctx.signal);
      const n = String(page.pageNumber).padStart(3, "0");
      const imageKey = `${prefix}/${n}.png`;
      const thumbKey = `${prefix}/${n}.thumb.png`;
      await storage.put(imageKey, page.image.buffer, "image/png");
      await storage.put(thumbKey, page.thumbnail.buffer, "image/png");
      const imageAssetId = randomUUID();
      const imageHash = sha256Hex(page.image.buffer);
      const thumbnailAssetId = randomUUID();
      await db.insert(assets).values([
        {
          id: imageAssetId,
          projectId,
          kind: "slide_image",
          storageKey: imageKey,
          mimeType: "image/png",
          sizeBytes: page.image.buffer.length,
          width: page.image.width,
          height: page.image.height,
          // What the page looks like (a swapped photo or recoloured chart changes it; notes don't):
          // the render fingerprint uses this to tell whether a video still shows the current slides.
          inputHash: imageHash,
          producedBy: { jobId: job.id },
        },
        {
          id: thumbnailAssetId,
          projectId,
          kind: "thumbnail",
          storageKey: thumbKey,
          mimeType: "image/png",
          sizeBytes: page.thumbnail.buffer.length,
          inputHash: page.contentHash,
          producedBy: { jobId: job.id },
        },
      ]);
      created.push({ page, imageAssetId, thumbnailAssetId, imageHash });
    }

    await ctx.emit(0.9, "建立頁面與場景");
    const { newSlides, newScenes } = await db.transaction(async (tx) => {
      const oldSlides = await tx.select().from(slides).where(eq(slides.projectId, projectId)).orderBy(asc(slides.index));
      const oldScenes = await tx.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.index));
      const oldSlideById = new Map(oldSlides.map((s) => [s.id, s]));

      const insertedSlides: SlideRow[] = [];
      for (let i = 0; i < created.length; i++) {
        const c = created[i]!;
        const [row] = await tx
          .insert(slides)
          .values({
            id: randomUUID(),
            projectId,
            sourceDocumentId: docId,
            index: i,
            pageNumber: c.page.pageNumber,
            contentHash: c.page.contentHash,
            imageAssetId: c.imageAssetId,
            thumbnailAssetId: c.thumbnailAssetId,
            content: c.page.content,
            hidden: false,
          })
          .returning();
        insertedSlides.push(row!);
      }

      // Picture hashes, to tell text-less pages apart (old slide images uploaded before pictures
      // were hashed carry the text hash instead: ignored).
      const oldImageIds = oldSlides.map((s) => s.imageAssetId).filter((id): id is string => !!id);
      const oldImages = oldImageIds.length ? await tx.select().from(assets).where(inArray(assets.id, oldImageIds)) : [];
      const hashByAsset = new Map(oldImages.map((a) => [a.id, a.inputHash]));
      const imageHashes = {
        new: new Map(insertedSlides.map((s, i) => [s.id, created[i]!.imageHash])),
        old: new Map(
          oldSlides.flatMap((s) => {
            const h = s.imageAssetId ? hashByAsset.get(s.imageAssetId) : undefined;
            return h && h !== s.contentHash ? [[s.id, h] as const] : [];
          }),
        ),
      };
      const matched = matchScenes(
        insertedSlides,
        oldScenes.map((sc) => ({ scene: sc, slide: oldSlideById.get(sc.slideId) })),
        imageHashes,
      );

      const resultScenes: SceneRow[] = [];
      for (let i = 0; i < insertedSlides.length; i++) {
        const slide = insertedSlides[i]!;
        const m = matched.get(slide.id);
        if (m) {
          // A page the user hid stays hidden, also when its slide was edited (a new date in every
          // footer must not bring 13 hidden pages back). A page kept from an earlier replacement
          // (page number past KEPT_PAGE_BASE) that is back in the deck shows again.
          const was = m.scene.slideId ? oldSlideById.get(m.scene.slideId) : undefined;
          // Matched only by position (content changed): carry 「hidden」 over only when it is plausibly
          // the same slide (same title), or a slide inserted early would shift the flag onto real content.
          const titleOf = (c: unknown) => ((c as { title?: string } | null)?.title ?? "").trim();
          // Untitled pages (pictures, PDFs without a detectable title): same page count means nothing
          // was inserted or removed, so position is trustworthy.
          const titled = !!titleOf(was?.content) || !!titleOf(slide.content);
          const sameSlide =
            m.kind === "same" || (titled ? titleOf(was?.content) === titleOf(slide.content) : created.length === oldSlides.filter((o) => o.pageNumber < KEPT_PAGE_BASE).length);
          if (was?.hidden && was.pageNumber < KEPT_PAGE_BASE && sameSlide) {
            const [h] = await tx.update(slides).set({ hidden: true }).where(eq(slides.id, slide.id)).returning();
            insertedSlides[i] = h!;
          }
          const staleScript: SceneAssetState =
            m.kind === "same" || m.scene.script.status === "missing" ? m.scene.script : { ...m.scene.script, status: "stale" };
          const [row] = await tx
            .update(scenes)
            .set({ slideId: slide.id, index: i, script: staleScript })
            .where(eq(scenes.id, m.scene.id))
            .returning();
          resultScenes.push(row!);
        } else {
          const empty: SceneAssetState = { status: "missing" };
          const [row] = await tx
            .insert(scenes)
            .values({ id: randomUUID(), projectId, slideId: slide.id, index: i, script: empty, audio: empty, avatar: empty, subtitle: empty })
            .returning();
          resultScenes.push(row!);
        }
      }
      const keptSceneIds = new Set(resultScenes.map((s) => s.id));
      let orphanScenes = oldScenes.filter((s) => !keptSceneIds.has(s.id)).map((s) => s.id);
      // A page with no match in the new deck whose script someone wrote or translated is kept, as a
      // hidden page at the end (with its old slide picture), instead of losing the text and its
      // history. The user can copy the text over or delete the page.
      if (orphanScenes.length) {
        const revs = await tx.select().from(scriptRevisions).where(inArray(scriptRevisions.sceneId, orphanScenes)).orderBy(desc(scriptRevisions.version));
        const latest = new Map<string, (typeof revs)[number]>();
        for (const r of revs) if (!latest.has(r.sceneId)) latest.set(r.sceneId, r);
        const keep = orphanScenes.filter((id) => {
          const src = latest.get(id)?.source;
          return src === "user" || src === "translation";
        });
        for (const id of keep) {
          const sc = oldScenes.find((s) => s.id === id)!;
          const old = oldSlideById.get(sc.slideId);
          if (!old) continue;
          const index = insertedSlides.length;
          const [copy] = await tx
            .insert(slides)
            // Page numbers past KEPT_PAGE_BASE: never matched by position against a later deck.
            // Hidden when first kept; a kept page the user turned back on stays on.
            .values({ ...old, id: randomUUID(), sourceDocumentId: docId, index, hidden: old.hidden || old.pageNumber < KEPT_PAGE_BASE, pageNumber: KEPT_PAGE_BASE + (old.pageNumber % KEPT_PAGE_BASE) })
            .returning();
          insertedSlides.push(copy!);
          const [row] = await tx.update(scenes).set({ slideId: copy!.id, index }).where(eq(scenes.id, id)).returning();
          resultScenes.push(row!);
        }
        orphanScenes = orphanScenes.filter((id) => !keep.includes(id));
      }
      if (orphanScenes.length) await tx.delete(scenes).where(inArray(scenes.id, orphanScenes));
      // Old slides of THIS project (previous document versions) are no longer referenced by any scene.
      // The project filter is essential: without it every other project's slides would be wiped.
      await tx.delete(slides).where(and(eq(slides.projectId, projectId), ne(slides.sourceDocumentId, docId)));
      await tx
        .update(sourceDocuments)
        .set({ parseStatus: "succeeded", pageCount: created.length })
        .where(eq(sourceDocuments.id, docId));
      return { newSlides: insertedSlides, newScenes: resultScenes };
    });

    ctx.publish({ kind: "slides", slides: newSlides.map(toSlide), scenes: newScenes.map(toScene) });
    await ctx.emit(1, "完成");
    return { pageCount: newSlides.length, warnings: manifest.meta.warnings, converter: manifest.meta.converter };
  } catch (err) {
    const cancelled = ctx.signal.aborted || (err as Error).name === "AbortError";
    // A server shutdown re-queues the job: the deck is waiting again, not stopped.
    const shutdown = abortedByShutdown(ctx.signal);
    await db
      .update(sourceDocuments)
      .set({ parseStatus: shutdown ? "queued" : cancelled ? "cancelled" : job.attempts >= job.maxAttempts || err instanceof NonRetryableJobError ? "failed" : "queued" })
      .where(eq(sourceDocuments.id, docId));
    throw err;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

async function loadPages(manifest: ParserManifest, outDir: string): Promise<ParsedPage[]> {
  const pages: ParsedPage[] = [];
  for (const entry of manifest.pages) {
    const content = SlideContent.parse(JSON.parse(await readFile(join(outDir, entry.contentPath), "utf8")));
    const image = await readFile(join(outDir, entry.imagePath));
    const thumbnail = await readFile(join(outDir, entry.thumbnailPath));
    pages.push({
      pageNumber: entry.pageNumber,
      content,
      // Text-based on purpose: outline and script hashes build on it (a picture hash here would make
      // every text-less page of an existing project 需更新 on its next upload). Text-less pages are
      // told apart by their picture in matchScenes instead.
      contentHash: slideContentHash(content.plainText, content.notes),
      image: { buffer: image, width: entry.imageWidthPx, height: entry.imageHeightPx },
      thumbnail: { buffer: thumbnail },
    });
  }
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  return pages;
}

type OldEntry = { scene: SceneRow; slide: SlideRow | undefined };
type Match = { scene: SceneRow; kind: "same" | "changed" };

/**
 * Pass 1: identical content hash => same scene, scripts intact.
 * Pass 2: same page number => same scene, script marked stale.
 * Anything else is a new scene; unmatched old scenes are deleted.
 */
/** Kept pages (hand-written scripts whose slide left the deck) carry page numbers from here up. */
export const KEPT_PAGE_BASE = 100_000;

/** contentHash of a page with no text and no notes (pictures, scanned PDFs). */
const EMPTY_TEXT_HASH = slideContentHash("", undefined);

export function matchScenes(
  newSlides: SlideRow[],
  old: OldEntry[],
  /** Picture hashes by slide id: text-less pages are matched by picture when both sides have one. */
  images: { new: Map<string, string>; old: Map<string, string> } = { new: new Map(), old: new Map() },
): Map<string, Match> {
  const out = new Map<string, Match>();
  const unused = new Set(old.map((_, i) => i));
  const byHash = new Map<string, number[]>();
  const byPage = new Map<number, number[]>();
  old.forEach((o, i) => {
    if (!o.slide) return;
    byHash.set(o.slide.contentHash, [...(byHash.get(o.slide.contentHash) ?? []), i]);
    byPage.set(o.slide.pageNumber, [...(byPage.get(o.slide.pageNumber) ?? []), i]);
  });
  const take = (list: number[] | undefined) => {
    const i = list?.find((x) => unused.has(x));
    if (i === undefined) return undefined;
    unused.delete(i);
    return old[i]!;
  };
  const pending: SlideRow[] = [];
  for (const s of newSlides) {
    if (s.contentHash === EMPTY_TEXT_HASH) {
      // Text-less: the same picture is the same page; an old page without a picture hash (older
      // upload) may still match in order, as before; a different picture is not 「same」.
      const pic = images.new.get(s.id);
      const candidates = (byHash.get(s.contentHash) ?? []).filter((i) => {
        const oldPic = old[i]!.slide ? images.old.get(old[i]!.slide!.id) : undefined;
        return !pic || !oldPic || oldPic === pic;
      });
      const samePic = pic ? candidates.find((i) => old[i]!.slide && images.old.get(old[i]!.slide!.id) === pic && unused.has(i)) : undefined;
      const hit = samePic !== undefined ? take([samePic]) : take(candidates);
      if (hit) out.set(s.id, { scene: hit.scene, kind: "same" });
      else pending.push(s);
      continue;
    }
    const hit = take(byHash.get(s.contentHash));
    if (hit) out.set(s.id, { scene: hit.scene, kind: "same" });
    else pending.push(s);
  }
  for (const s of pending) {
    const hit = take(byPage.get(s.pageNumber));
    if (hit) out.set(s.id, { scene: hit.scene, kind: "changed" });
  }
  return out;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
