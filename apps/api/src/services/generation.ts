/**
 * Real implementations of the generation seams: @lvs/pipeline for prompts/texts/subtitles,
 * @lvs/providers for LLM / TTS / avatar calls, @lvs/render for the final MP4.
 * Each seam persists its own result (asset rows, scene state, usage) and publishes events.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, inArray } from "drizzle-orm";
import type {
  Asset,
  AvatarProvider,
  OutlineRevision,
  ProjectSettings,
  RenderScene,
  RenderSpec,
  Scene,
  ScriptRevision,
  Slide,
  SubtitleCue,
  Track,
} from "@lvs/shared";
import { detectPauses } from "./audio.js";
import {
  buildCues,
  cuesToSrt,
  generateOutline as pipelineOutline,
  generateSceneScript,
  type PipelineSlide,
} from "@lvs/pipeline";
import { render } from "@lvs/render";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { toAsset, toOutline, toScene } from "../db/mappers.js";
import { assets, outlineRevisions, projects, scenes, timelineRevisions, type SceneRow } from "../db/schema.js";
import { NonRetryableJobError } from "../errors.js";
import type { JobContext } from "../jobs/context.js";
import { throwIfAborted } from "../jobs/context.js";
import type { GenerationSeams } from "../jobs/handlers/generation.js";
import { scriptInputHash, subtitleInputHash } from "../jobs/hashes.js";
import { ProviderNotConfiguredError, type ProviderService } from "./providers.js";
import { createScriptRevision } from "./scripts.js";
import { recordUsage, type UsageLine } from "./usage.js";
import type { StorageService } from "../storage/types.js";

export interface GenerationDeps {
  providers: ProviderService;
  config: Config;
}

function scaleSubtitleStyle<T extends { fontSizePx: number; marginPx: number; outlineWidthPx?: number }>(style: T, factor: number): T {
  if (factor === 1) return style;
  return {
    ...style,
    fontSizePx: Math.max(10, Math.round(style.fontSizePx * factor)),
    marginPx: Math.max(0, Math.round(style.marginPx * factor)),
    ...(style.outlineWidthPx ? { outlineWidthPx: Math.max(1, Math.round(style.outlineWidthPx * factor)) } : {}),
  };
}

const PRESETS: Record<string, Record<ProjectSettings["aspectRatio"], { width: number; height: number }>> = {
  preview_540p: { "16:9": { width: 960, height: 540 }, "9:16": { width: 540, height: 960 }, "1:1": { width: 540, height: 540 } },
  hd_1080p: { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 } },
};

const AUDIO_EXT: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg" };

/** Providers whose avatar clips come on a green screen instead of an alpha channel. */
// The local worker composites its own person matte onto the same green (lvs_avatar/matting.py).
const CHROMA_KEY_BY_PROVIDER: Record<string, string> = { heygen: "#00FF00", local: "#00FF00" };

/** Hold time for a muted scene with no narration. */
const MUTED_SCENE_SEC = 3;

export function createGenerationSeams(deps: GenerationDeps): GenerationSeams {
  const { providers, config } = deps;

  async function ownerOf(ctx: JobContext): Promise<string> {
    const [p] = await ctx.db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, ctx.job.projectId)).limit(1);
    if (!p) throw new NonRetryableJobError("project not found");
    return p.ownerId;
  }

  /** Missing keys are a configuration problem, not a transient failure. */
  async function withProvider<P>(fn: () => Promise<P>): Promise<P> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw new NonRetryableJobError(e.message);
      throw e;
    }
  }

  async function assetById(db: Db, id: string): Promise<Asset> {
    const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!row) throw new NonRetryableJobError(`asset ${id} not found`);
    return toAsset(row);
  }

  async function sceneRow(db: Db, id: string): Promise<SceneRow> {
    const [row] = await db.select().from(scenes).where(eq(scenes.id, id)).limit(1);
    if (!row) throw new NonRetryableJobError(`scene ${id} not found`);
    return row;
  }

  async function readAsset(storage: StorageService, asset: Asset): Promise<Buffer> {
    const { stream } = await storage.getStream(asset.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }

  /** Local file for an asset: the storage path when the backend is local, else a copy in `dir`. */
  async function localFile(storage: StorageService, asset: Asset, dir: string): Promise<string> {
    if (storage.localPath) return storage.localPath(asset.storageKey);
    const out = join(dir, "inputs", asset.id + (asset.storageKey.match(/\.[a-z0-9]+$/i)?.[0] ?? ""));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await readAsset(storage, asset));
    return out;
  }

  async function toPipelineSlides(ctx: JobContext, slidesInOrder: Slide[], maxImages: number): Promise<PipelineSlide[]> {
    const imageIds = slidesInOrder.slice(0, maxImages).map((s) => s.imageAssetId).filter((id): id is string => !!id);
    const imageRows = imageIds.length ? await ctx.db.select().from(assets).where(inArray(assets.id, imageIds)) : [];
    const byId = new Map(imageRows.map((r) => [r.id, toAsset(r)]));
    const out: PipelineSlide[] = [];
    for (let i = 0; i < slidesInOrder.length; i++) {
      const s = slidesInOrder[i]!;
      const img = s.imageAssetId ? byId.get(s.imageAssetId) : undefined;
      out.push({
        id: s.id,
        index: i,
        content: s.content,
        ...(img ? { imagePng: new Uint8Array(await readAsset(ctx.storage, img)) } : {}),
      });
    }
    return out;
  }

  async function putAsset(
    ctx: JobContext,
    args: { kind: Asset["kind"]; key: string; data: Buffer | string; mimeType: string; inputHash?: string; durationSec?: number; width?: number; height?: number; providerId?: string; providerTaskId?: string },
  ): Promise<Asset> {
    const { storage, db, job } = ctx;
    const put = typeof args.data === "string" ? await storage.put(args.key, createReadStream(args.data), args.mimeType) : await storage.put(args.key, args.data, args.mimeType);
    const [row] = await db
      .insert(assets)
      .values({
        id: randomUUID(),
        projectId: job.projectId,
        kind: args.kind,
        storageKey: args.key,
        mimeType: args.mimeType,
        sizeBytes: put.sizeBytes,
        durationSec: args.durationSec ?? null,
        width: args.width ?? null,
        height: args.height ?? null,
        inputHash: args.inputHash ?? null,
        producedBy: { jobId: job.id, ...(args.providerId ? { providerId: args.providerId } : {}), ...(args.providerTaskId ? { providerTaskId: args.providerTaskId } : {}) },
      })
      .returning();
    const asset = toAsset(row!);
    ctx.publish({ kind: "asset", asset });
    return asset;
  }

  async function publishScene(ctx: JobContext, sceneId: string): Promise<Scene> {
    const scene = toScene(await sceneRow(ctx.db, sceneId));
    ctx.publish({ kind: "scene", scene });
    return scene;
  }

  async function usage(ctx: JobContext, providerId: string, deltas: UsageLine[]) {
    await recordUsage(ctx.db, { projectId: ctx.job.projectId, jobId: ctx.job.id, providerId, usage: deltas });
  }

  return {
    async generateOutline({ ctx, slidesInOrder, settings, inputHash }) {
      const ownerId = await ownerOf(ctx);
      const llm = await withProvider(() => providers.llm(ownerId, settings.llmProviderId));
      const slides = await toPipelineSlides(ctx, slidesInOrder, config.OUTLINE_MAX_IMAGES);
      throwIfAborted(ctx.signal);
      ctx.log.info("calling LLM for the outline", { provider: llm.id, model: llm.defaultModel, slides: slides.length, images: Math.min(slides.length, config.OUTLINE_MAX_IMAGES) });
      const { outline, usage: used } = await pipelineOutline({ llm, slides, settings, maxImages: config.OUTLINE_MAX_IMAGES, attachImages: config.OUTLINE_MAX_IMAGES > 0 });
      ctx.log.info("outline received", { sections: outline.sections.length, glossary: outline.glossary.length });
      await usage(ctx, llm.id, used);
      const [latest] = await ctx.db
        .select({ version: outlineRevisions.version })
        .from(outlineRevisions)
        .where(eq(outlineRevisions.projectId, ctx.job.projectId))
        .orderBy(desc(outlineRevisions.version))
        .limit(1);
      const [row] = await ctx.db
        .insert(outlineRevisions)
        .values({
          id: randomUUID(),
          projectId: ctx.job.projectId,
          version: (latest?.version ?? 0) + 1,
          objectives: outline.objectives,
          summary: outline.summary,
          sections: outline.sections,
          glossary: outline.glossary,
          timeAllocation: outline.timeAllocation,
          inputHash,
        })
        .returning();
      await ctx.emit(1, "大綱完成");
      return toOutline(row!);
    },

    async generateScript({ ctx, scene, slide, prev, next, outline, settings, previousScript }) {
      if (!outline) throw new NonRetryableJobError("no outline yet; run generate_outline first");
      const ownerId = await ownerOf(ctx);
      const llm = await withProvider(() => providers.llm(ownerId, settings.llmProviderId));
      const mk = async (s: Slide | undefined, index: number, withImage: boolean): Promise<PipelineSlide | undefined> => {
        if (!s) return undefined;
        const img = withImage && s.imageAssetId ? await assetById(ctx.db, s.imageAssetId) : undefined;
        return { id: s.id, index, content: s.content, ...(img ? { imagePng: new Uint8Array(await readAsset(ctx.storage, img)) } : {}) };
      };
      const allocated = outline.timeAllocation[slide.id] ?? 30;
      const result = await generateSceneScript({
        llm,
        slide: (await mk(slide, scene.index, config.SCRIPT_ATTACH_IMAGE))!,
        prevSlide: await mk(prev, scene.index - 1, false),
        nextSlide: await mk(next, scene.index + 1, false),
        outline,
        settings,
        allocatedSec: allocated,
        previousScripts: previousScript ? [previousScript] : [],
        attachImage: config.SCRIPT_ATTACH_IMAGE,
      });
      await usage(ctx, llm.id, result.usage);
      throwIfAborted(ctx.signal);
      const { revision } = await createScriptRevision(ctx.db, {
        scene: await sceneRow(ctx.db, scene.id),
        script: result.script,
        pronunciationText: result.pronunciationText,
        subtitleText: result.subtitleText,
        source: "ai",
        language: settings.language,
        outlineRevisionId: outline.id,
        inputHash: scriptInputHash({ slide, prev, next, outlineInputHash: outline.inputHash, settings }),
        glossary: outline.glossary,
        estimatedDurationSec: result.estimatedDurationSec,
      });
      await publishScene(ctx, scene.id);
      return revision;
    },

    async synthesizeSpeech({ ctx, scene, script, settings, inputHash, outline, progress }) {
      const report = progress ?? (async () => {});
      const ownerId = await ownerOf(ctx);
      const tts = await withProvider(() => providers.tts(ownerId, settings.voice.providerId));
      await report(0.1, "呼叫語音服務");
      const glossary = outline?.glossary ?? [];
      const res = await tts.synthesize({
        text: script.pronunciationText,
        voiceId: settings.voice.voiceId,
        language: settings.language,
        speed: settings.voice.speed,
        sentencePauseSec: settings.voice.sentencePauseSec,
        pronunciation: glossary,
      });
      await usage(ctx, tts.id, res.usage);
      await report(0.7, "儲存語音");
      throwIfAborted(ctx.signal);
      const { audio, mimeType, durationSec, timestamps } = res.data;
      const ext = AUDIO_EXT[mimeType] ?? "bin";
      const base = `projects/${ctx.job.projectId}/scenes/${scene.id}`;
      const audioAsset = await putAsset(ctx, {
        kind: "audio",
        key: `${base}/audio-${inputHash.slice(0, 12)}.${ext}`,
        data: Buffer.from(audio),
        mimeType,
        inputHash,
        durationSec,
        providerId: tts.id,
      });

      // Without provider timestamps, snap cue boundaries to the pauses the TTS put at sentence ends.
      const audioLocal = ctx.storage.localPath?.(audioAsset.storageKey);
      const pauses = !timestamps?.length && audioLocal ? await detectPauses(audioLocal, { ffmpegBin: config.FFMPEG_BIN, signal: ctx.signal }) : [];
      await report(0.85, "對齊字幕");
      const cues = buildCues({
        subtitleText: script.subtitleText,
        timestamps,
        pauses,
        durationSec,
        maxCharsPerLine: settings.subtitles.style.maxCharsPerLine,
        language: settings.language,
      });
      const subHash = subtitleInputHash({ audioInputHash: inputHash, subtitleText: script.subtitleText, settings });
      const srtAsset = await putAsset(ctx, {
        kind: "subtitle",
        key: `${base}/subtitle-${subHash.slice(0, 12)}.srt`,
        data: Buffer.from(cuesToSrt(cues), "utf8"),
        mimeType: "application/x-subrip",
        inputHash: subHash,
        durationSec,
      });

      const row = await sceneRow(ctx.db, scene.id);
      const prevAvatar = row.avatar;
      await ctx.db
        .update(scenes)
        .set({
          durationSec,
          audio: { status: "ready", assetId: audioAsset.id, inputHash, jobId: ctx.job.id },
          subtitle: { status: "ready", assetId: srtAsset.id, inputHash: subHash, jobId: ctx.job.id, cues },
          // New audio invalidates any avatar clip driven by the old audio.
          avatar: prevAvatar.status === "missing" ? prevAvatar : { ...prevAvatar, status: "stale" },
        })
        .where(eq(scenes.id, scene.id));
      await publishScene(ctx, scene.id);
    },

    async generateAvatar({ ctx, scene, audioAssetId, settings, inputHash }) {
      const providerId = settings.avatar.providerId;
      const avatarId = settings.avatar.avatarId;
      if (!providerId || !avatarId) throw new NonRetryableJobError("avatar provider and avatarId must be set in project settings");
      const ownerId = await ownerOf(ctx);
      const provider = await withProvider(() => providers.avatar(ownerId, providerId));
      const audioAsset = await assetById(ctx.db, audioAssetId);

      // Reuse the provider task a crashed attempt already created for this scene (no double billing).
      const prefix = `${scene.id}:`;
      let taskId = ctx.job.providerTaskId?.startsWith(prefix) ? ctx.job.providerTaskId.slice(prefix.length) : undefined;
      if (!taskId) {
        const { url } = ctx.storage.signUrl(audioAsset.id, config.AVATAR_AUDIO_URL_TTL_SEC);
        // Hand the provider the bytes as well as a URL: HeyGen uploads them as an asset, which
        // also works when the API runs on localhost where no vendor could fetch the URL.
        const audioBytes = await streamToBuffer((await ctx.storage.getStream(audioAsset.storageKey)).stream);
        const created = await provider.createTask({
          avatarId,
          aspectRatio: settings.aspectRatio,
          audio: { data: audioBytes, mimeType: audioAsset.mimeType, fileName: `scene-${scene.index + 1}.${AUDIO_EXT[audioAsset.mimeType] ?? "bin"}` },
          audioUrl: url,
          clientReference: ctx.job.id,
        });
        taskId = created.taskId;
        await ctx.setProviderTaskId(prefix + taskId);
      }

      const status = await pollAvatar(provider, taskId, ctx, config.AVATAR_POLL_INTERVAL_MS, scene.index);
      if (!status.resultUrl) throw new Error(`avatar task ${taskId} succeeded without a result url`);
      const clip = await download(status.resultUrl);
      const durationSec = status.durationSec ?? audioAsset.durationSec ?? 0;
      await usage(ctx, provider.id, [{ unit: "avatar_seconds", quantity: durationSec }]);
      const asset = await putAsset(ctx, {
        kind: "avatar_video",
        key: `projects/${ctx.job.projectId}/scenes/${scene.id}/avatar-${inputHash.slice(0, 12)}.mp4`,
        data: clip,
        mimeType: "video/mp4",
        inputHash,
        durationSec,
        providerId: provider.id,
        providerTaskId: taskId,
      });
      await ctx.db
        .update(scenes)
        .set({ avatar: { status: "ready", assetId: asset.id, inputHash, jobId: ctx.job.id } })
        .where(eq(scenes.id, scene.id));
      await publishScene(ctx, scene.id);
    },

    async renderVideo({ ctx, scenesInOrder, settings, inputHash, preset, burnSubtitles }) {
      const size = PRESETS[preset]?.[settings.aspectRatio];
      if (!size) throw new NonRetryableJobError(`unknown render preset ${preset}`);
      const workDir = resolve(config.RENDER_WORK_DIR, ctx.job.projectId, ctx.job.id);
      const cacheDir = resolve(config.RENDER_WORK_DIR, ctx.job.projectId, "cache");
      await mkdir(workDir, { recursive: true });

      const assetIds = new Set<string>();
      for (const s of scenesInOrder) for (const id of [s.audio.assetId, s.avatar.assetId]) if (id) assetIds.add(id);
      const slideRows = await ctx.db.select().from(scenes).where(inArray(scenes.id, scenesInOrder.map((s) => s.id)));
      const slideIdByScene = new Map(slideRows.map((r) => [r.id, r.slideId]));
      const { slides } = await import("../db/schema.js");
      const slideRowsAll = await ctx.db.select().from(slides).where(inArray(slides.id, [...slideIdByScene.values()]));
      for (const s of slideRowsAll) if (s.imageAssetId) assetIds.add(s.imageAssetId);
      const assetRows = assetIds.size ? await ctx.db.select().from(assets).where(inArray(assets.id, [...assetIds])) : [];
      const assetMap = new Map(assetRows.map((r) => [r.id, toAsset(r)]));
      const imageBySlide = new Map(slideRowsAll.map((s) => [s.id, s.imageAssetId]));

      const renderScenes: RenderScene[] = [];
      for (let i = 0; i < scenesInOrder.length; i++) {
        const s = scenesInOrder[i]!;
        const imageId = imageBySlide.get(slideIdByScene.get(s.id) ?? "");
        const image = imageId ? assetMap.get(imageId) : undefined;
        if (!image) throw new NonRetryableJobError(`scene ${s.index + 1} has no slide image`);
        const audio = !s.muted && s.audio.assetId ? assetMap.get(s.audio.assetId) : undefined;
        const narration = audio?.durationSec ?? s.durationSec ?? (s.muted ? MUTED_SCENE_SEC : 0);
        const durationSec = Math.max(0.5, narration + s.tailPauseSec);
        const avatarAsset = settings.avatar.enabled && !s.muted && s.avatar.status === "ready" && s.avatar.assetId ? assetMap.get(s.avatar.assetId) : undefined;
        const layout = s.avatarLayout ?? settings.avatar.layout;
        const chroma = avatarAsset?.producedBy.providerId ? CHROMA_KEY_BY_PROVIDER[avatarAsset.producedBy.providerId] : undefined;
        const cues: SubtitleCue[] = settings.subtitles.enabled && !s.muted ? (s.subtitle.cues ?? []) : [];
        renderScenes.push({
          sceneId: s.id,
          imagePath: await localFile(ctx.storage, image, workDir),
          ...(audio ? { audioPath: await localFile(ctx.storage, audio, workDir) } : {}),
          durationSec,
          ...(avatarAsset && layout.visible
            ? { avatar: { videoPath: await localFile(ctx.storage, avatarAsset, workDir), layout, hasAlpha: false, ...(chroma ? { chromaKey: chroma } : {}) } }
            : {}),
          subtitles: cues,
          transitionIn: i === 0 ? "none" : (s.transitionIn ?? settings.transition),
          transitionDurationSec: 0.4,
        });
      }

      const spec: RenderSpec = {
        schemaVersion: 1,
        width: size.width,
        height: size.height,
        fps: 30,
        scenes: renderScenes,
        // Style sizes are authored for 1080p; scale them to the preset so previews wrap the same way.
        subtitleStyle: scaleSubtitleStyle(settings.subtitles.style, size.height / 1080),
        burnSubtitles: burnSubtitles && settings.subtitles.enabled,
        backgroundColor: settings.backgroundColor ?? "#000000",
        outputs: { mp4Path: join(workDir, "output.mp4"), srtPath: join(workDir, "output.srt") },
      };
      await ctx.emit(0.1, "渲染場景");
      const result = await render(spec, {
        workDir,
        cacheDir,
        ffmpegBin: config.FFMPEG_BIN,
        ffprobeBin: config.FFPROBE_BIN,
        signal: ctx.signal,
        onProgress: (p: number, msg: string) => void ctx.emit(0.1 + p * 0.8, msg),
      });
      await usage(ctx, "render", [{ unit: "render_seconds", quantity: result.renderSeconds }]);

      await ctx.emit(0.92, "儲存輸出");
      const base = `projects/${ctx.job.projectId}/renders/${inputHash.slice(0, 12)}`;
      const video = await putAsset(ctx, {
        kind: "video",
        key: `${base}.mp4`,
        data: result.mp4Path,
        mimeType: "video/mp4",
        inputHash,
        durationSec: result.durationSec,
        width: result.width,
        height: result.height,
      });
      let srtAssetId: string | undefined;
      if (result.srtPath && (await stat(result.srtPath).catch(() => null))) {
        const srt = await putAsset(ctx, { kind: "subtitle", key: `${base}.srt`, data: result.srtPath, mimeType: "application/x-subrip", inputHash, durationSec: result.durationSec });
        srtAssetId = srt.id;
      }

      // Derived timeline: one clip per scene on each track, so the editor can draw it.
      const tracks = buildTimelineTracks(renderScenes, scenesInOrder);
      const [latest] = await ctx.db
        .select({ version: timelineRevisions.version })
        .from(timelineRevisions)
        .where(eq(timelineRevisions.projectId, ctx.job.projectId))
        .orderBy(desc(timelineRevisions.version))
        .limit(1);
      await ctx.db.insert(timelineRevisions).values({
        id: randomUUID(),
        projectId: ctx.job.projectId,
        version: (latest?.version ?? 0) + 1,
        totalDurationSec: result.durationSec,
        tracks,
      });
      await ctx.emit(1, "完成");
      return { videoAssetId: video.id, ...(srtAssetId ? { srtAssetId } : {}) };
    },
  };
}

async function pollAvatar(provider: AvatarProvider, taskId: string, ctx: JobContext, intervalMs: number, sceneIndex: number) {
  let delay = intervalMs;
  for (;;) {
    if (ctx.signal.aborted) {
      await provider.cancelTask(taskId).catch(() => undefined);
      throwIfAborted(ctx.signal);
    }
    const st = await provider.getTask(taskId);
    if (st.status === "succeeded") return st;
    if (st.status === "failed") throw new NonRetryableJobError(`avatar provider failed: ${st.error ?? "unknown error"}`);
    if (st.status === "cancelled") throw Object.assign(new Error("avatar task cancelled"), { name: "AbortError" });
    await ctx.emit(Math.min(0.95, 0.1 + (st.progress ?? 0) * 0.8), `等待第 ${sceneIndex + 1} 段人像生成`);
    await sleep(delay, ctx.signal);
    delay = Math.min(delay * 1.5, Math.max(intervalMs, 30_000));
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      res();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function download(url: string): Promise<Buffer> {
  if (url.startsWith("file://")) return readFile(fileURLToPath(url));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url.split("?")[0]}`);
  return Buffer.from(await res.arrayBuffer());
}

function buildTimelineTracks(renderScenes: RenderScene[], scenesInOrder: Scene[]): Track[] {
  const slide: Track = { kind: "slide", clips: [] };
  const avatar: Track = { kind: "avatar", clips: [] };
  const narration: Track = { kind: "narration", clips: [] };
  const subtitle: Track = { kind: "subtitle", clips: [] };
  let t = 0;
  for (let i = 0; i < renderScenes.length; i++) {
    const rs = renderScenes[i]!;
    const sc = scenesInOrder[i]!;
    const overlap = i > 0 && rs.transitionIn === "fade" ? rs.transitionDurationSec : 0;
    const start = Math.max(0, t - overlap);
    const clip = (assetId: string | undefined) => ({
      id: randomUUID(),
      sceneId: sc.id,
      ...(assetId ? { assetId } : {}),
      startSec: round(start),
      durationSec: round(rs.durationSec),
      speed: 1,
      transitionIn: rs.transitionIn,
    });
    slide.clips.push(clip(undefined));
    if (rs.audioPath) narration.clips.push(clip(sc.audio.assetId));
    if (rs.avatar) avatar.clips.push(clip(sc.avatar.assetId));
    if (rs.subtitles.length) subtitle.clips.push(clip(sc.subtitle.assetId));
    t = start + rs.durationSec;
  }
  return [slide, avatar, narration, subtitle];
}

const round = (n: number) => Math.round(n * 1000) / 1000;


async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
