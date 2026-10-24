/**
 * Generation handlers. Each is wired end-to-end (loads inputs, decides which scenes need
 * work, keeps the job lifecycle correct) and delegates the actual provider call to one
 * clearly marked function that @lvs/pipeline / @lvs/providers will fill in.
 */
import { and, desc, eq } from "drizzle-orm";
import { avatarInVideo } from "@lvs/shared";
import type { GlossaryEntry, Language, OutlineRevision, ProjectSettings, Scene, ScriptRevision, Slide } from "@lvs/shared";
import { toScene } from "../../db/mappers.js";
import { assets, projects, scenes } from "../../db/schema.js";
import { NonRetryableJobError, NotImplementedJobError } from "../../errors.js";
import { getProjectDetail } from "../../services/projects.js";
import { createScriptRevision } from "../../services/scripts.js";
import { throwIfAborted, type JobContext, type JobHandler } from "../context.js";
import { audioInputHash, avatarInputHash, outlineInputHash, renderInputHash, scriptInputHash } from "../hashes.js";
import { audioReady, avatarTargets, doneBy, narratedCandidates, pageList, pageNo, scriptTargets, speechTargets, visibleScenesOf } from "../plan.js";

async function loadDetail(ctx: JobContext) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, ctx.job.projectId)).limit(1);
  if (!project) throw new NonRetryableJobError("找不到這個專案");
  const detail = await getProjectDetail(ctx.db, project.ownerId, ctx.job.projectId);
  const slidesById = new Map(detail.slides.map((s) => [s.id, s]));
  const visibleScenes = visibleScenesOf(detail);
  return { project, detail, slidesById, visibleScenes };
}

/**
 * Switching a character away and back must not bill the same clip twice: when this project
 * already holds an avatar clip made from exactly these inputs (the hash covers the page's audio
 * asset, character, engine and aspect ratio), the page points at it again instead of calling
 * the provider. Returns whether it did.
 */
async function reuseAvatarClip(ctx: JobContext, sceneId: string, inputHash: string): Promise<boolean> {
  const [earlier] = await ctx.db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, ctx.job.projectId), eq(assets.kind, "avatar_video"), eq(assets.inputHash, inputHash)))
    .orderBy(desc(assets.createdAt))
    .limit(1);
  if (!earlier || !(await ctx.storage.stat(earlier.storageKey))) return false;
  await ctx.db
    .update(scenes)
    .set({ avatar: { status: "ready", assetId: earlier.id, inputHash, jobId: ctx.job.id } })
    .where(eq(scenes.id, sceneId));
  const [row] = await ctx.db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (row) ctx.publish({ kind: "scene", scene: toScene(row) });
  return true;
}

const NO_SLIDES = "專案還沒有投影片，請先上傳簡報";
export const AVATAR_HIDDEN = "目前的版面是「只有投影片」，影片不會出現人像，所以不製作人像。要人像請先在「人像與聲音」選一個有人像的版面";
export const AVATAR_DISABLED = "這個專案沒有啟用人像，請到「人像與聲音」分頁開啟";
export const AVATAR_NOT_SELECTED = "請先在「人像與聲音」分頁選擇人像";

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
    /** 「AI 重寫本頁」 direction, applied to `currentScript`. */
    instruction?: string;
    currentScript?: string;
  }): Promise<ScriptRevision>;
  /** TODO(providers): TtsProvider.synthesize → store `audio` asset (+ timestamps) and `subtitle` asset (SRT); update scene states + durationSec. */
  synthesizeSpeech(args: {
    ctx: JobContext;
    scene: Scene;
    script: ScriptRevision;
    settings: ProjectSettings;
    inputHash: string;
    outline: OutlineRevision | undefined;
    /** Reports progress within this scene (0..1) so single-page jobs still move. */
    progress?: (stage: number, message: string) => Promise<void>;
  }): Promise<void>;
  /** TODO(providers): AvatarProvider.createTask with the audio asset URL; ctx.setProviderTaskId(taskId) BEFORE polling; store `avatar_video` asset. */
  generateAvatar(args: { ctx: JobContext; scene: Scene; audioAssetId: string; settings: ProjectSettings; inputHash: string }): Promise<void>;
  /** TODO(render): build RenderSpec from scenes/assets (storage.localPath), run @lvs/render, store `video` + `subtitle` assets. */
  renderVideo(args: { ctx: JobContext; scenesInOrder: Scene[]; settings: ProjectSettings; inputHash: string; preset: string; burnSubtitles: boolean }): Promise<{ videoAssetId: string; srtAssetId?: string }>;
  /** One page's narration translated by the LLM, with the spoken + subtitle texts for the target language. */
  translateScript(args: {
    ctx: JobContext;
    settings: ProjectSettings;
    from: Language;
    to: Language;
    script: string;
    previousScript?: string;
    nextScript?: string;
    glossary: GlossaryEntry[];
    title: string;
    pageNumber: number;
    pageCount: number;
  }): Promise<{ script: string; pronunciationText: string; subtitleText: string; estimatedDurationSec: number }>;
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
  translateScript: async () => {
    throw new NotImplementedJobError("translate_script");
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Progress for multi-scene jobs is weighted by narration time, not page count, and the
 * denominator is the whole deck: pages already done count as done, so "generate all" starts
 * where it left off, while a single-page job spans 0..1 for that page alone.
 */
function progressPlan<T extends { id: string }>(all: T[], targets: T[], weightOf: (s: T) => number) {
  const w = (s: T) => Math.max(1, weightOf(s) || 0);
  const targetIds = new Set(targets.map((t) => t.id));
  const single = targets.length === 1;
  const scope = single ? targets : all;
  const total = scope.reduce((a, s) => a + w(s), 0) || 1;
  let done = single ? 0 : scope.filter((s) => !targetIds.has(s.id)).reduce((a, s) => a + w(s), 0);
  return {
    /** fraction before starting `scene` */
    start: (scene: T) => done / total,
    /** fraction at `stage` (0..1) inside `scene` */
    within: (scene: T, stage: number) => (done + w(scene) * Math.min(1, Math.max(0, stage))) / total,
    finish: (scene: T) => {
      done += w(scene);
      return done / total;
    },
  };
}

export function makeGenerationHandlers(seams: GenerationSeams) {
  const generateOutline: JobHandler<{ type: "generate_outline"; force: boolean }> = async (ctx) => {
    const { detail, visibleScenes, slidesById } = await loadDetail(ctx);
    const slidesInOrder = visibleScenes.map((sc) => slidesById.get(sc.slideId)!).filter(Boolean);
    if (slidesInOrder.length === 0) throw new NonRetryableJobError(NO_SLIDES);
    const inputHash = outlineInputHash(slidesInOrder, detail.project.settings);
    if (!ctx.job.payload.force && detail.outline?.inputHash === inputHash) {
      return { outlineRevisionId: detail.outline.id, reused: true };
    }
    await ctx.emit(0.1, "規劃全篇大綱");
    const outline = await seams.generateOutline({ ctx, slidesInOrder, settings: detail.project.settings, inputHash });
    ctx.publish({ kind: "outline", outline });
    return { outlineRevisionId: outline.id, reused: false };
  };

  const generateScript: JobHandler<{ type: "generate_script"; sceneIds?: string[]; force: boolean; instruction?: string }> = async (ctx) => {
    let { detail, visibleScenes, slidesById } = await loadDetail(ctx);
    // The editor's single "產生講稿" button must work on a fresh project: plan the outline first
    // when it is missing or no longer matches the slides/settings, then write the scripts.
    const slidesInOrder = visibleScenes.map((sc) => slidesById.get(sc.slideId)!).filter(Boolean);
    if (slidesInOrder.length === 0) throw new NonRetryableJobError(NO_SLIDES);
    const outlineHash = outlineInputHash(slidesInOrder, detail.project.settings);
    if (!detail.outline || detail.outline.inputHash !== outlineHash) {
      await ctx.emit(0.02, "規劃全篇大綱");
      const outline = await seams.generateOutline({ ctx, slidesInOrder, settings: detail.project.settings, inputHash: outlineHash });
      ctx.publish({ kind: "outline", outline });
      ({ detail, visibleScenes, slidesById } = await loadDetail(ctx));
    }
    const targets = scriptTargets(detail, { sceneIds: ctx.job.payload.sceneIds, force: ctx.job.payload.force, jobId: ctx.job.id });
    const ids: string[] = [];
    // Scenes are processed in deck order so each prompt can see the script written just before it.
    const latestScript = new Map(Object.entries(detail.scripts).map(([sceneId, rev]) => [sceneId, rev.script]));
    const alloc = detail.outline?.timeAllocation ?? {};
    const plan = progressPlan(visibleScenes, targets, (s) => alloc[s.slideId] ?? Math.max(10, (slidesById.get(s.slideId)?.content.plainText.length ?? 0) / 8));
    // Pages are written a few at a time (SCRIPT_CONCURRENCY). Each prompt still sees the outline,
    // the neighbouring slides and, when it is already written, the previous page's script.
    const concurrency = Math.max(1, Math.min(ctx.config.SCRIPT_CONCURRENCY ?? 3, targets.length));
    const results = new Map<string, string>();
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= targets.length) return;
        if (ctx.signal.aborted) return;
        const scene = targets[i]!;
        const pos = visibleScenes.findIndex((s) => s.id === scene.id);
        const slide = slidesById.get(scene.slideId)!;
        const prevScene = pos > 0 ? visibleScenes[pos - 1] : undefined;
        await ctx.emit(plan.start(scene), `正在產生第 ${pageNo(scene)} 頁講稿`);
        const rev = await seams.generateScript({
          ctx,
          scene,
          slide,
          prev: prevScene ? slidesById.get(prevScene.slideId) : undefined,
          next: pos < visibleScenes.length - 1 ? slidesById.get(visibleScenes[pos + 1]!.slideId) : undefined,
          outline: detail.outline,
          settings: detail.project.settings,
          previousScript: prevScene ? latestScript.get(prevScene.id) : undefined,
          ...(ctx.job.payload.instruction ? { instruction: ctx.job.payload.instruction, currentScript: latestScript.get(scene.id) } : {}),
        });
        latestScript.set(scene.id, rev.script);
        results.set(scene.id, rev.id);
        ctx.publish({ kind: "script", script: rev });
        await ctx.emit(plan.finish(scene), `第 ${pageNo(scene)} 頁講稿完成`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    for (const scene of targets) {
      const id = results.get(scene.id);
      if (id) ids.push(id);
    }
    return { scriptRevisionIds: ids, processed: targets.length, skipped: visibleScenes.length - targets.length };
  };

  /** Runs the speech seam for one scene; shared by synthesize_speech and generate_avatar. */
  async function speakScene(
    ctx: JobContext,
    detail: Awaited<ReturnType<typeof loadDetail>>["detail"],
    scene: Scene,
    progress: (stage: number, message: string) => Promise<void>,
  ) {
    const script = detail.scripts[scene.id]!;
    const inputHash = audioInputHash({ pronunciationText: script.pronunciationText, settings: detail.project.settings, glossaryReadings: detail.outline?.glossary });
    await seams.synthesizeSpeech({ ctx, scene, script, settings: detail.project.settings, inputHash, outline: detail.outline, progress });
  }

  const narrationWeight = (detail: Awaited<ReturnType<typeof loadDetail>>["detail"]) => (s: Scene) =>
    s.durationSec ?? detail.scripts[s.id]?.estimatedDurationSec ?? (detail.scripts[s.id]?.script.length ?? 0) / 4.5;

  const synthesizeSpeech: JobHandler<{ type: "synthesize_speech"; sceneIds?: string[]; force: boolean }> = async (ctx) => {
    const { detail } = await loadDetail(ctx);
    const withScript = narratedCandidates(detail);
    const targets = speechTargets(detail, { sceneIds: ctx.job.payload.sceneIds, force: ctx.job.payload.force, jobId: ctx.job.id });
    const plan = progressPlan(withScript, targets, narrationWeight(detail));
    for (const scene of targets) {
      const n = pageNo(scene);
      await ctx.emit(plan.start(scene), `正在產生第 ${n} 頁語音`);
      await speakScene(ctx, detail, scene, (stage, message) => ctx.emit(plan.within(scene, stage), `第 ${n} 頁：${message}`));
      await ctx.emit(plan.finish(scene), `第 ${n} 頁語音完成`);
    }
    return { processed: targets.length, skipped: withScript.length - targets.length };
  };

  const generateAvatar: JobHandler<{ type: "generate_avatar"; sceneIds?: string[]; force: boolean }> = async (ctx) => {
    const { detail } = await loadDetail(ctx);
    const settings = detail.project.settings;
    if (!settings.avatar.enabled) throw new NonRetryableJobError(AVATAR_DISABLED);
    if (!settings.avatar.providerId || !settings.avatar.avatarId) throw new NonRetryableJobError(AVATAR_NOT_SELECTED);
    if (!avatarInVideo(settings.avatar)) throw new NonRetryableJobError(AVATAR_HIDDEN);
    // Every narrated page with a script is a candidate; pages whose audio is missing or stale
    // get it synthesized first, so "產生人像" never silently skips them.
    const candidates = narratedCandidates(detail);
    const targets = avatarTargets(detail, { sceneIds: ctx.job.payload.sceneIds, force: ctx.job.payload.force, jobId: ctx.job.id });
    const plan = progressPlan(candidates, targets, narrationWeight(detail));
    let synthesized = 0;
    let reused = 0;
    for (const target of targets) {
      const n = pageNo(target);
      let scene = target;
      // Share of this page's progress spent on speech when it has to be synthesized first.
      let speechShare = 0;
      if (!audioReady(scene)) {
        speechShare = 0.3;
        await ctx.emit(plan.start(scene), `正在產生第 ${n} 頁語音`);
        await speakScene(ctx, detail, scene, (stage, message) => ctx.emit(plan.within(target, stage * speechShare), `第 ${n} 頁：${message}`));
        synthesized++;
        const [row] = await ctx.db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
        if (!row?.audio.assetId || row.audio.status !== "ready") throw new NonRetryableJobError(`第 ${n} 頁語音產生失敗，無法產生人像`);
        scene = { ...toScene(row), index: target.index };
      }
      const audioAssetId = scene.audio.assetId!;
      const inputHash = avatarInputHash({ audioAssetId, settings });
      if (await reuseAvatarClip(ctx, scene.id, inputHash)) {
        reused++;
        await ctx.emit(plan.finish(target), `第 ${n} 頁沿用先前做好的人像（不另收費）`);
        continue;
      }
      await ctx.emit(plan.within(target, speechShare), `正在產生第 ${n} 頁人像`);
      await seams.generateAvatar({ ctx, scene, audioAssetId, settings, inputHash });
      await ctx.emit(plan.finish(target), `第 ${n} 頁人像完成`);
    }
    return { processed: targets.length, skipped: candidates.length - targets.length, synthesized, reused };
  };

  const renderVideo: JobHandler<{ type: "render_video"; preset: "preview_540p" | "hd_1080p"; burnSubtitles?: boolean }> = async (ctx) => {
    const { detail, visibleScenes } = await loadDetail(ctx);
    const burn = ctx.job.payload.burnSubtitles ?? detail.project.settings.subtitles.burnIn;
    if (visibleScenes.length === 0) throw new NonRetryableJobError(NO_SLIDES);
    const notReady = visibleScenes.filter((s) => !s.muted && s.audio.status !== "ready");
    if (notReady.length) {
      throw new NonRetryableJobError(`第 ${pageList(notReady)} 頁的語音不是最新的，請先按上方的「補齊語音」，或在「匯出影片」裡按「產生語音並匯出」`);
    }
    const inputHash = renderInputHash({
      scenesInOrder: visibleScenes,
      settings: detail.project.settings,
      preset: ctx.job.payload.preset,
      burnSubtitles: burn,
      slidesById: new Map(detail.slides.map((sl) => [sl.id, sl])),
    });
    await ctx.emit(0.05, "準備合成影片");
    const out = await seams.renderVideo({ ctx, scenesInOrder: visibleScenes, settings: detail.project.settings, inputHash, preset: ctx.job.payload.preset, burnSubtitles: burn });
    return { ...out, inputHash };
  };

  /**
   * Fills a translated copy's scripts from its source project: page i of the copy gets page i's
   * latest script, translated with the neighbouring pages and the source glossary as context.
   * The scripts count as AI-written and current for the copy's slides, so nothing reads 需更新.
   */
  const translateScripts: JobHandler<{ type: "translate_script"; sourceProjectId: string; targetLanguage: Language }> = async (ctx) => {
    const { project, detail, slidesById } = await loadDetail(ctx);
    const source = await getProjectDetail(ctx.db, project.ownerId, ctx.job.payload.sourceProjectId);
    const settings = detail.project.settings;
    const from = source.project.settings.language;
    const to = ctx.job.payload.targetLanguage;
    const srcByIndex = new Map(source.scenes.map((s) => [s.index, s]));
    const srcText = (index: number) => {
      const sc = srcByIndex.get(index);
      return sc ? (source.scripts[sc.id]?.script ?? "").trim() : "";
    };
    // Same slide order and outline hash withEffectiveStatuses uses, so the scripts read as current.
    const orderedSlides = detail.scenes.map((s) => slidesById.get(s.slideId)).filter((s): s is Slide => !!s);
    const outlineHash = detail.outline?.inputHash ?? outlineInputHash(orderedSlides, settings);
    // A retry skips pages this job already translated (edits made there meanwhile are kept).
    const targets = detail.scenes.filter((s) => srcText(s.index) && !doneBy(ctx.job.id, s.script));
    const plan = progressPlan(targets, targets, (s) => srcText(s.index).length);
    let translated = 0;
    // Pages are independent (context comes from the source text), so a few run at once.
    const concurrency = Math.max(1, Math.min(ctx.config.SCRIPT_CONCURRENCY ?? 3, targets.length));
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const scene = targets.at(cursor++);
        if (!scene || ctx.signal.aborted) return;
        await translateOne(scene);
      }
    };
    const translateOne = async (scene: Scene) => {
      throwIfAborted(ctx.signal);
      const i = detail.scenes.findIndex((s) => s.id === scene.id);
      await ctx.emit(plan.start(scene), `正在翻譯第 ${pageNo(scene)} 頁講稿`);
      const out = await seams.translateScript({
        ctx,
        settings,
        from,
        to,
        script: srcText(scene.index),
        previousScript: srcText(scene.index - 1) || undefined,
        nextScript: srcText(scene.index + 1) || undefined,
        glossary: source.outline?.glossary ?? [],
        title: source.project.name,
        pageNumber: pageNo(scene),
        pageCount: detail.scenes.length,
      });
      const slide = slidesById.get(scene.slideId);
      const [row] = await ctx.db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
      if (!slide || !row) return;
      const { revision } = await createScriptRevision(ctx.db, {
        scene: row,
        script: out.script,
        pronunciationText: out.pronunciationText,
        subtitleText: out.subtitleText,
        // Made from the source project's script, so hiding or reordering pages here must not
        // mark it stale (that would point 下一步 at 產生全部講稿 and overwrite the translation).
        source: "translation",
        language: to,
        jobId: ctx.job.id,
        inputHash: scriptInputHash({ slide, prev: orderedSlides[i - 1], next: orderedSlides[i + 1], outlineInputHash: outlineHash, settings }),
        estimatedDurationSec: out.estimatedDurationSec,
      });
      ctx.publish({ kind: "script", script: revision });
      const [fresh] = await ctx.db.select().from(scenes).where(eq(scenes.id, scene.id)).limit(1);
      if (fresh) ctx.publish({ kind: "scene", scene: toScene(fresh) });
      translated++;
      await ctx.emit(plan.finish(scene), `第 ${pageNo(scene)} 頁翻譯完成`);
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    throwIfAborted(ctx.signal);
    return { translated, skipped: detail.scenes.length - translated };
  };

  return { generateOutline, generateScript, synthesizeSpeech, generateAvatar, renderVideo, translateScripts };
}
