import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  CreateProjectRequest,
  CreateTranslationRequest,
  EnqueueJobRequest,
  JobType,
  ProjectSettings,
  ReorderSlidesRequest,
  UpdateGlossaryRequest,
  UpdateProjectRequest,
  UpdateSceneRequest,
  UpdateScriptRequest,
} from "@lvs/shared";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { toJob, toProject, toScene, toScriptRevision, toSlide, toSourceDocument } from "../db/mappers.js";
import { jobs, projects, scenes, scriptRevisions, slides, sourceDocuments } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { renderScriptDocument } from "../jobs/handlers/export-script.js";
import { estimateJob } from "../services/estimate.js";
import { getProjectDetail, latestOutline, latestSourceDocument, projectListExtras, requireProject } from "../services/projects.js";
import { updateGlossary } from "../services/glossary.js";
import { createScriptRevision } from "../services/scripts.js";
import { createTranslatedProject } from "../services/translation.js";
import { SOURCE_MIME, sniffSourceKind } from "../util/magic.js";
import { parse } from "../util/validate.js";

const HEAD_BYTES = 64 * 1024;

/**
 * Objects the editor always sends whole: replaced, not merged, so a field the new value leaves
 * out is really gone (an avatar layout without x/y means "back to the corner"; merging kept the
 * old dragged position forever, since JSON cannot carry `undefined`).
 */
const REPLACED_WHOLE = new Set(["layout"]);

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (REPLACED_WHOLE.has(k)) out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out as T;
}

/** Job types that work page by page and cost money: at most one at a time per page. */
/** Projects with a deck upload in progress (one server process). */
const uploading = new Set<string>();

const PAGE_JOBS = new Set(["generate_script", "synthesize_speech", "generate_avatar", "translate_script"]);
/** Jobs that write the same thing: a presenter job also makes missing narration. */
const CLASHES: Record<string, string[]> = {
  synthesize_speech: ["synthesize_speech", "generate_avatar"],
  generate_avatar: ["synthesize_speech", "generate_avatar"],
};
const JOB_LABEL: Record<string, string> = { generate_script: "產生講稿", synthesize_speech: "產生語音", generate_avatar: "產生人像", translate_script: "翻譯講稿" };

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get("/projects", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const rows = await db.select().from(projects).where(eq(projects.ownerId, ownerId)).orderBy(desc(projects.updatedAt));
    const extras = await projectListExtras(
      db,
      rows.map((r) => r.id),
    );
    // Progress for the cards (length, whether the exported video is current), as VoAI/HeyGen show it.
    const progress = await Promise.all(
      rows.map(async (r) => {
        try {
          const d = await getProjectDetail(db, ownerId, r.id);
          const video = Object.values(d.assets)
            .filter((a) => a.kind === "video")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          const videoStatus = !video
            ? ("none" as const)
            : d.currentRenderHashes.length === 0 || d.currentRenderHashes.includes(video.inputHash ?? "")
              ? ("current" as const)
              : ("outdated" as const);
          return { totalDurationSec: d.totalDurationSec, videoStatus };
        } catch {
          return {};
        }
      }),
    );
    return rows.map((r, i) => {
      const e = extras.get(r.id) ?? {};
      return {
        ...toProject(r),
        pageCount: e.pageCount,
        activePageCount: e.activePageCount,
        ...progress[i],
        ...(e.thumbnailAssetId ? { thumbnailAssetId: e.thumbnailAssetId } : {}),
      };
    });
  });

  app.post("/projects", async (req, reply) => {
    const body = parse(CreateProjectRequest, req.body);
    const { ownerId } = ctx.auth.resolve(req);
    const settings = ProjectSettings.parse(body.settings ?? {});
    const [row] = await db.insert(projects).values({ id: randomUUID(), ownerId, name: body.name, settings }).returning();
    reply.code(201);
    return toProject(row!);
  });

  // A copy of the project in another language (deck copied, scripts translated by a job).
  app.post<{ Params: { id: string } }>("/projects/:id/translations", async (req, reply) => {
    const { ownerId } = ctx.auth.resolve(req);
    const body = parse(CreateTranslationRequest, req.body);
    const result = await createTranslatedProject(ctx, ownerId, req.params.id, body.language, body.name, body.voiceId);
    reply.code(201);
    return result;
  });

  app.get<{ Params: { id: string } }>("/projects/:id", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    return getProjectDetail(db, ownerId, req.params.id);
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const body = parse(UpdateProjectRequest, req.body);
    const current = await requireProject(db, ownerId, req.params.id);
    const settings = body.settings ? ProjectSettings.parse(deepMerge(current.settings as Record<string, unknown>, body.settings)) : current.settings;
    const [row] = await db
      .update(projects)
      .set({ name: body.name ?? current.name, settings, updatedAt: new Date() })
      .where(eq(projects.id, current.id))
      .returning();
    const project = toProject(row!);
    ctx.bus.publish(project.id, { kind: "project", project });
    return project;
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const active = await db.select().from(jobs).where(and(eq(jobs.projectId, project.id), inArray(jobs.status, ["queued", "running"])));
    for (const j of active) await ctx.runner.cancel(j.id);
    await db.delete(projects).where(eq(projects.id, project.id));
    // Storage objects are left for a sweeper; keys are prefixed by project id.
    reply.code(204);
    return null;
  });

  // ------------------------------------------------------------ upload ----

  app.post<{ Params: { id: string } }>("/projects/:id/source", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    // Replacing the deck while pages are being written, voiced or animated would let those jobs
    // keep working (and paying) for pages the new deck no longer has.
    const [busy] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, project.id), inArray(jobs.type, [...PAGE_JOBS, "render_video", "parse_document"]), inArray(jobs.status, ["queued", "running"])))
      .limit(1);
    // Two decks read at once would delete each other's pages (and the scripts on them).
    if (busy) throw conflict(`「${JOB_LABEL[busy.type] ?? (busy.type === "parse_document" ? "解析簡報" : "匯出影片")}」正在進行，請等它完成（或在「工作」停止）後再替換簡報。`);
    // The parse job only exists once the file has arrived: hold the project for the whole upload, so a
    // second upload (another tab, a quick re-drop) can't slip in meanwhile.
    if (uploading.has(project.id)) throw conflict("另一份簡報正在上傳，請等它完成後再替換。");
    uploading.add(project.id);
    try {
    const part = await req.file();
    if (!part) throw badRequest("multipart field `file` is required");

    const scratch = await mkdtemp(join(tmpdir(), "lvs-upload-"));
    const tmpPath = join(scratch, "upload.bin");
    const hash = createHash("sha256");
    const headChunks: Buffer[] = [];
    let headLen = 0;
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        if (headLen < HEAD_BYTES) {
          headChunks.push(chunk.subarray(0, HEAD_BYTES - headLen));
          headLen += Math.min(chunk.length, HEAD_BYTES - headLen);
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(part.file, tap, createWriteStream(tmpPath));
      if (part.file.truncated) throw badRequest(`file exceeds ${ctx.config.MAX_UPLOAD_BYTES} bytes`);
      const kind = sniffSourceKind(Buffer.concat(headChunks), part.filename);
      if (!kind) throw badRequest("unsupported file type; upload a .pptx, .ppt or .pdf");

      const previous = await latestSourceDocument(db, project.id);
      const docId = randomUUID();
      const safeName = part.filename.replace(/[^\w.\-一-鿿]+/g, "_").slice(0, 120) || `deck.${kind}`;
      const storageKey = `projects/${project.id}/source/${docId}/${safeName}`;
      await ctx.storage.put(storageKey, createReadStream(tmpPath), SOURCE_MIME[kind]);
      const [row] = await db
        .insert(sourceDocuments)
        .values({
          id: docId,
          projectId: project.id,
          filename: part.filename,
          mimeType: SOURCE_MIME[kind],
          kind,
          storageKey,
          sizeBytes: size,
          sha256: hash.digest("hex"),
          version: (previous?.version ?? 0) + 1,
          parseStatus: "queued",
        })
        .returning();
      const job = await ctx.runner.enqueue(project.id, { type: "parse_document", sourceDocumentId: docId }, { dedupeKey: `parse:${docId}` });
      await db.update(sourceDocuments).set({ parseJobId: job.id }).where(eq(sourceDocuments.id, docId));
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
      return { sourceDocument: toSourceDocument({ ...row!, parseJobId: job.id }), job };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    } finally {
      uploading.delete(project.id);
    }
  });

  // ------------------------------------------------------------ slides ----

  app.post<{ Params: { id: string } }>("/projects/:id/slides/reorder", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const body = parse(ReorderSlidesRequest, req.body);
    const existing = await db.select().from(slides).where(eq(slides.projectId, project.id));
    const ids = new Set(existing.map((s) => s.id));
    if (body.slideIds.length !== ids.size || body.slideIds.some((id) => !ids.has(id)) || new Set(body.slideIds).size !== ids.size) {
      throw badRequest("slideIds must be a permutation of the project's slides");
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < body.slideIds.length; i++) {
        const slideId = body.slideIds[i]!;
        await tx.update(slides).set({ index: i }).where(eq(slides.id, slideId));
        await tx.update(scenes).set({ index: i }).where(eq(scenes.slideId, slideId));
      }
      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
    });
    const [newSlides, newScenes] = await Promise.all([
      db.select().from(slides).where(eq(slides.projectId, project.id)).orderBy(asc(slides.index)),
      db.select().from(scenes).where(eq(scenes.projectId, project.id)).orderBy(asc(scenes.index)),
    ]);
    const payload = { slides: newSlides.map(toSlide), scenes: newScenes.map(toScene) };
    ctx.bus.publish(project.id, { kind: "slides", ...payload });
    return payload;
  });

  app.patch<{ Params: { id: string; slideId: string } }>("/projects/:id/slides/:slideId", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const body = parse(z.object({ hidden: z.boolean() }), req.body);
    const [row] = await db
      .update(slides)
      .set({ hidden: body.hidden })
      .where(and(eq(slides.id, req.params.slideId), eq(slides.projectId, project.id)))
      .returning();
    if (!row) throw notFound("slide", req.params.slideId);
    const [all, allScenes] = await Promise.all([
      db.select().from(slides).where(eq(slides.projectId, project.id)).orderBy(asc(slides.index)),
      db.select().from(scenes).where(eq(scenes.projectId, project.id)).orderBy(asc(scenes.index)),
    ]);
    ctx.bus.publish(project.id, { kind: "slides", slides: all.map(toSlide), scenes: allScenes.map(toScene) });
    return toSlide(row);
  });

  // ------------------------------------------------------------ scenes ----

  const requireScene = async (projectId: string, sceneId: string) => {
    const [row] = await db
      .select()
      .from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("scene", sceneId);
    return row;
  };

  app.patch<{ Params: { id: string; sceneId: string } }>("/projects/:id/scenes/:sceneId", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const body = parse(UpdateSceneRequest, req.body);
    await requireScene(project.id, req.params.sceneId);
    const set: Partial<typeof scenes.$inferInsert> = {};
    if (body.muted !== undefined) set.muted = body.muted;
    if (body.avatarLayout !== undefined) set.avatarLayout = body.avatarLayout;
    if (body.transitionIn !== undefined) set.transitionIn = body.transitionIn;
    if (body.tailPauseSec !== undefined) set.tailPauseSec = body.tailPauseSec;
    const [row] = await db.update(scenes).set(set).where(eq(scenes.id, req.params.sceneId)).returning();
    const scene = toScene(row!);
    ctx.bus.publish(project.id, { kind: "scene", scene });
    return scene;
  });

  app.put<{ Params: { id: string; sceneId: string } }>("/projects/:id/scenes/:sceneId/script", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const body = parse(UpdateScriptRequest, req.body);
    const scene = await requireScene(project.id, req.params.sceneId);
    const outline = await latestOutline(db, project.id);
    const { revision, created } = await createScriptRevision(db, {
      scene,
      script: body.script,
      pronunciationText: body.pronunciationText,
      subtitleText: body.subtitleText,
      source: "user",
      language: project.settings.language,
      deriveTexts: ctx.deriveTexts,
      glossary: outline?.glossary,
    });
    if (created) {
      const [fresh] = await db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
      ctx.bus.publish(project.id, { kind: "script", script: revision });
      if (fresh) ctx.bus.publish(project.id, { kind: "scene", scene: toScene(fresh) });
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
    } else if (scene.script.status === "stale") {
      // Same text re-saved as 「講稿沒問題」: the scene may have turned ready (see createScriptRevision).
      const [fresh] = await db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
      if (fresh) ctx.bus.publish(project.id, { kind: "scene", scene: toScene(fresh) });
    }
    return revision;
  });

  app.put<{ Params: { id: string } }>("/projects/:id/outline/glossary", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const body = parse(UpdateGlossaryRequest, req.body);
    const result = await updateGlossary(ctx, ownerId, project.id, body.glossary);
    await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
    return result;
  });

  app.get<{ Params: { id: string; sceneId: string } }>("/projects/:id/scenes/:sceneId/scripts", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    await requireScene(project.id, req.params.sceneId);
    const rows = await db
      .select()
      .from(scriptRevisions)
      .where(eq(scriptRevisions.sceneId, req.params.sceneId))
      .orderBy(desc(scriptRevisions.version));
    return rows.map(toScriptRevision);
  });

  // -------------------------------------------------------------- jobs ----

  app.post<{ Params: { id: string } }>("/projects/:id/jobs", async (req, reply) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const payload = parse(EnqueueJobRequest, req.body);
    const dedupeKey = payload.type === "generate_outline" || payload.type === "render_video" ? `${payload.type}:${JSON.stringify(payload)}` : undefined;
    // A double click or a second tab must not start the same paid work twice: refuse a job of the
    // same kind while one is queued or running for any of the same pages.
    // While a new deck is being read, its pages are about to change: no page work or export yet.
    if (PAGE_JOBS.has(payload.type) || payload.type === "render_video") {
      const [parsing] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, project.id), eq(jobs.type, "parse_document"), inArray(jobs.status, ["queued", "running"])))
        .limit(1);
      if (parsing) throw conflict("簡報正在更新（解析新檔案中），完成後再開始這項工作。");
    }
    if (PAGE_JOBS.has(payload.type)) {
      const mine = (payload as { sceneIds?: string[] }).sceneIds;
      const active = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, project.id), inArray(jobs.type, CLASHES[payload.type] ?? [payload.type]), inArray(jobs.status, ["queued", "running"])));
      const clash = active.find((j) => {
        const other = (j.payload as { sceneIds?: string[] }).sceneIds;
        return !mine?.length || !other?.length || other.some((id) => mine.includes(id));
      });
      if (clash) throw conflict(`「${JOB_LABEL[clash.type] ?? clash.type}」已經在進行中，請等它完成再開始（可按「工作」查看進度）。`);
    }
    // Estimate before enqueueing (the runner may start the job right away) with the job's own
    // selection: force → everything, sceneIds respected.
    let estimate;
    if (["generate_outline", "generate_script", "synthesize_speech", "generate_avatar", "render_video"].includes(payload.type)) {
      const sel = payload as { force?: boolean; sceneIds?: string[] };
      estimate = estimateJob(await getProjectDetail(db, ownerId, project.id), payload.type, { force: !!sel.force, sceneIds: sel.sceneIds });
    }
    const job = await ctx.runner.enqueue(project.id, payload, { dedupeKey });
    reply.code(202);
    return { job, estimate };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/projects/:id/jobs", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const where = req.query.status
      ? and(eq(jobs.projectId, project.id), eq(jobs.status, req.query.status))
      : eq(jobs.projectId, project.id);
    const rows = await db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(200);
    return rows.map(toJob);
  });

  app.post<{ Params: { id: string; jobId: string } }>("/projects/:id/jobs/:jobId/cancel", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    const [row] = await db.select().from(jobs).where(and(eq(jobs.id, req.params.jobId), eq(jobs.projectId, project.id))).limit(1);
    if (!row) throw notFound("job", req.params.jobId);
    return (await ctx.runner.cancel(row.id)) ?? toJob(row);
  });

  app.get<{ Params: { id: string }; Querystring: { type?: string; scope?: string; sceneIds?: string } }>("/projects/:id/estimate", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const type = parse(JobType, req.query.type, "query.type");
    const scope = parse(z.enum(["pending", "all"]).default("pending"), req.query.scope, "query.scope");
    const sceneIds = req.query.sceneIds
      ? parse(z.array(z.string().uuid()), req.query.sceneIds.split(",").map((x) => x.trim()).filter(Boolean), "query.sceneIds")
      : undefined;
    return estimateJob(await getProjectDetail(db, ownerId, req.params.id), type, { force: scope === "all", sceneIds });
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/projects/:id/export/script", async (req, reply) => {
    const { ownerId } = ctx.auth.resolve(req);
    const format = parse(z.enum(["txt", "md"]).default("md"), req.query.format, "query.format");
    const detail = await getProjectDetail(db, ownerId, req.params.id);
    const text = renderScriptDocument(detail, format);
    const safe = detail.project.name.replace(/[^\w\-一-鿿]+/g, "_");
    reply.header("Content-Type", format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.${format}`);
    return reply.send(text);
  });

  // ------------------------------------------------------------ events ----

  app.get<{ Params: { id: string } }>("/projects/:id/events", async (req, reply) => {
    const { ownerId } = ctx.auth.resolve(req);
    const project = await requireProject(db, ownerId, req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": (req.headers.origin as string | undefined) ?? "*",
    });
    res.write(`: connected ${project.id}\n\n`);
    const unsubscribe = ctx.bus.subscribe(project.id, (event) => {
      res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.raw.on("close", cleanup);
    res.on("close", cleanup);
  });
}
