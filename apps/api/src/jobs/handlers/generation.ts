/**
 * Generation handlers. Each is wired end-to-end (loads inputs, decides which scenes need
 * work, keeps the job lifecycle correct) and delegates the actual provider call to one
 * clearly marked function that @lvs/pipeline / @lvs/providers will fill in.
 */
import { eq } from "drizzle-orm";
import type { OutlineRevision, ProjectSettings, Scene, ScriptRevision, Slide } from "@lvs/shared";
import { projects } from "../../db/schema.js";
import { NonRetryableJobError, NotImplementedJobError } from "../../errors.js";
import { getProjectDetail } from "../../services/projects.js";
import type { JobContext, JobHandler } from "../context.js";
import { audioInputHash, avatarInputHash, outlineInputHash, renderInputHash, selectScenesToProcess } from "../hashes.js";

async function loadDetail(ctx: JobContext) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, ctx.job.projectId)).limit(1);
  if (!project) throw new NonRetryableJobError("project not found");
  const detail = await getProjectDetail(ctx.db, project.ownerId, ctx.job.projectId);
  const slidesById = new Map(detail.slides.map((s) => [s.id, s]));
  const visibleScenes = detail.scenes.filter((sc) => !slidesById.get(sc.slideId)?.hidden);
  return { project, detail, slidesById, visibleScenes };
}

// ---------------------------------------------------------------------------
// Seams. Replace the bodies; keep the signatures.
// ---------------------------------------------------------------------------

export interface GenerationSeams {
  /** TODO(pipeline): `@lvs/pipeline`.generateOutline(llm, slides, settings) → persist outline_revisions row. */
  generateOutline(args: {
    ctx: JobContext;
    slidesInOrder: Slide[];
    settings: ProjectSettings;
    inputHash: string;
  }): Promise<OutlineRevision>;
  /** TODO(pipeline): per-scene script with neighbours + outline + glossary → createScriptRevision(source="ai"). */
  generateScript(args: {
    ctx: JobContext;
    scene: Scene;
    slide: Slide;
    prev?: Slide;
    next?: Slide;
    outline: OutlineRevision | undefined;
    settings: ProjectSettings;
    /** Latest script of the preceding visible scene, for continuity. */
    previousScript?: string;
  }): Promise<ScriptRevision>;
  /** TODO(providers): TtsProvider.synthesize → store `audio` asset (+ timestamps) and `subtitle` asset (SRT); update scene states + durationSec. */
  synthesizeSpeech(args: {
    ctx: JobContext;
    scene: Scene;
    script: ScriptRevision;
    settings: ProjectSettings;
    inputHash: string;
    outline: OutlineRevision | undefined;
  }): Promise<void>;
  /** TODO(providers): AvatarProvider.createTask with the audio asset URL; ctx.setProviderTaskId(taskId) BEFORE polling; store `avatar_video` asset. */
  generateAvatar(args: { ctx: JobContext; scene: Scene; audioAssetId: string; settings: ProjectSettings; inputHash: string }): Promise<void>;
  /** TODO(render): build RenderSpec from scenes/assets (storage.localPath), run @lvs/render, store `video` + `subtitle` assets. */
  renderVideo(args: { ctx: JobContext; scenesInOrder: Scene[]; settings: ProjectSettings; inputHash: string; preset: string; burnSubtitles: boolean }): Promise<{ videoAssetId: string; srtAssetId?: string }>;
}

export const unimplementedSeams: GenerationSeams = {
  generateOutline: async () => {
    throw new NotImplementedJobError("generate_outline");
  },
  generateScript: async () => {
    throw new NotImplementedJobError("generate_script");
  },
  synthesizeSpeech: async () => {
    throw new NotImplementedJobError("synthesize_speech");
  },
  generateAvatar: async () => {
    throw new NotImplementedJobError("generate_avatar");
  },
  renderVideo: async () => {
    throw new NotImplementedJobError("render_video");
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function makeGenerationHandlers(seams: GenerationSeams) {
  const generateOutline: JobHandler<{ type: "generate_outline"; force: boolean }> = async (ctx) => {
    const { detail, visibleScenes, slidesById } = await loadDetail(ctx);
    const slidesInOrder = visibleScenes.map((sc) => slidesById.get(sc.slideId)!).filter(Boolean);
    if (slidesInOrder.length === 0) throw new NonRetryableJobError("project has no slides");
    const inputHash = outlineInputHash(slidesInOrder, detail.project.settings);
    if (!ctx.job.payload.force && detail.outline?.inputHash === inputHash) {
      return { outlineRevisionId: detail.outline.id, reused: true };
    }
    await ctx.emit(0.1, "規劃全篇大綱");
    const outline = await seams.generateOutline({ ctx, slidesInOrder, settings: detail.project.settings, inputHash });
    ctx.publish({ kind: "outline", outline });
    return { outlineRevisionId: outline.id, reused: false };
  };

  const generateScript: JobHandler<{ type: "generate_script"; sceneIds?: string[]; force: boolean }> = async (ctx) => {
    const { detail, visibleScenes, slidesById } = await loadDetail(ctx);
    const targets = selectScenesToProcess(visibleScenes, ctx.job.payload.sceneIds, ctx.job.payload.force, (s) => s.script.status);
    const ids: string[] = [];
    // Scenes are processed in deck order so each prompt can see the script written just before it.
    const latestScript = new Map(Object.entries(detail.scripts).map(([sceneId, rev]) => [sceneId, rev.script]));
    for (let i = 0; i < targets.length; i++) {
      const scene = targets[i]!;
      const pos = visibleScenes.findIndex((s) => s.id === scene.id);
      const slide = slidesById.get(scene.slideId)!;
      const prevScene = pos > 0 ? visibleScenes[pos - 1] : undefined;
      await ctx.emit(i / Math.max(1, targets.length), `生成第 ${slide.pageNumber} 頁講稿`);
      const rev = await seams.generateScript({
        ctx,
        scene,
        slide,
        prev: prevScene ? slidesById.get(prevScene.slideId) : undefined,
        next: pos < visibleScenes.length - 1 ? slidesById.get(visibleScenes[pos + 1]!.slideId) : undefined,
        outline: detail.outline,
        settings: detail.project.settings,
        previousScript: prevScene ? latestScript.get(prevScene.id) : undefined,
      });
      latestScript.set(scene.id, rev.script);
      ids.push(rev.id);
      ctx.publish({ kind: "script", script: rev });
    }
    return { scriptRevisionIds: ids, processed: targets.length, skipped: visibleScenes.length - targets.length };
  };

  const synthesizeSpeech: JobHandler<{ type: "synthesize_speech"; sceneIds?: string[]; force: boolean }> = async (ctx) => {
    const { detail, visibleScenes } = await loadDetail(ctx);
    const withScript = visibleScenes.filter((s) => !s.muted && detail.scripts[s.id]);
    const targets = selectScenesToProcess(withScript, ctx.job.payload.sceneIds, ctx.job.payload.force, (s) => s.audio.status);
    for (let i = 0; i < targets.length; i++) {
      const scene = targets[i]!;
      const script = detail.scripts[scene.id]!;
      const inputHash = audioInputHash({ pronunciationText: script.pronunciationText, settings: detail.project.settings, glossaryReadings: detail.outline?.glossary });
      await ctx.emit(i / Math.max(1, targets.length), `合成第 ${scene.index + 1} 段語音`);
      await seams.synthesizeSpeech({ ctx, scene, script, settings: detail.project.settings, inputHash, outline: detail.outline });
    }
    return { processed: targets.length, skipped: withScript.length - targets.length };
  };

  const generateAvatar: JobHandler<{ type: "generate_avatar"; sceneIds?: string[]; force: boolean }> = async (ctx) => {
    const { detail, visibleScenes } = await loadDetail(ctx);
    if (!detail.project.settings.avatar.enabled) throw new NonRetryableJobError("avatar is disabled in project settings");
    const withAudio = visibleScenes.filter((s) => !s.muted && s.audio.status === "ready" && s.audio.assetId);
    const targets = selectScenesToProcess(withAudio, ctx.job.payload.sceneIds, ctx.job.payload.force, (s) => s.avatar.status);
    for (let i = 0; i < targets.length; i++) {
      const scene = targets[i]!;
      const inputHash = avatarInputHash({ audioAssetId: scene.audio.assetId!, settings: detail.project.settings });
      await ctx.emit(i / Math.max(1, targets.length), `生成第 ${scene.index + 1} 段人像`);
      await seams.generateAvatar({ ctx, scene, audioAssetId: scene.audio.assetId!, settings: detail.project.settings, inputHash });
    }
    return { processed: targets.length, skipped: withAudio.length - targets.length };
  };

  const renderVideo: JobHandler<{ type: "render_video"; preset: "preview_540p" | "hd_1080p"; burnSubtitles?: boolean }> = async (ctx) => {
    const { detail, visibleScenes } = await loadDetail(ctx);
    const burn = ctx.job.payload.burnSubtitles ?? detail.project.settings.subtitles.burnIn;
    const notReady = visibleScenes.filter((s) => !s.muted && s.audio.status !== "ready");
    if (notReady.length) {
      throw new NonRetryableJobError(`${notReady.length} scene(s) have no up-to-date audio; run synthesize_speech first`);
    }
    const inputHash = renderInputHash({ scenesInOrder: visibleScenes, settings: detail.project.settings, preset: ctx.job.payload.preset, burnSubtitles: burn });
    await ctx.emit(0.05, "準備渲染");
    const out = await seams.renderVideo({ ctx, scenesInOrder: visibleScenes, settings: detail.project.settings, inputHash, preset: ctx.job.payload.preset, burnSubtitles: burn });
    return { ...out, inputHash };
  };

  return { generateOutline, generateScript, synthesizeSpeech, generateAvatar, renderVideo };
}
