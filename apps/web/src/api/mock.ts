import {
  ProjectSettings,
  type Asset,
  type CostEstimate,
  type CreateProjectRequest,
  type EnqueueJobRequest,
  type EnqueueJobResponse,
  type Job,
  type JobPayload,
  type JobStatus,
  type OutlineRevision,
  type Project,
  type ProjectDetail,
  type ProjectEvent,
  type ProviderInfo,
  type ReorderSlidesRequest,
  type Scene,
  type SceneAssetState,
  type ScriptRevision,
  type SetProviderKeyRequest,
  type Slide,
  type SourceDocument,
  type UpdateProjectRequest,
  type UpdateSceneRequest,
  type UpdateScriptRequest,
} from "@lvs/shared";
import { computeTotalDuration, estimateSpeechSeconds, sortByIndex } from "../lib/scenes";
import { toneWavDataUrl } from "../lib/wav";
import {
  DEMO_PROJECT_NAME,
  DEMO_SOURCE_FILENAME,
  FIXTURE_GLOSSARY,
  FIXTURE_OBJECTIVES,
  FIXTURE_PAGE3_V1,
  FIXTURE_SCRIPTS,
  FIXTURE_SECTIONS,
  FIXTURE_SLIDES,
  FIXTURE_SUMMARY,
  MOCK_AVATARS,
  MOCK_PRICES,
  MOCK_PROVIDERS,
  MOCK_VOICES,
  derivePronunciation,
  deriveSubtitle,
  mockScriptFor,
  type FixtureSlide,
} from "./mockFixture";
import { avatarPlaceholderSvg, renderSlideArt, type SlideRenderer } from "./mockImages";
import {
  ApiRequestError,
  type ApiClient,
  type AssetUrlResponse,
  type AvatarOption,
  type EstimateType,
  type HealthResponse,
  type ProjectEventListener,
  type ProjectSummary,
  type ReorderSlidesResponse,
  type ScriptExportFormat,
  type UploadOptions,
  type UploadSourceResponse,
  type VoiceOption,
} from "./types";

export interface MockApiOptions {
  /** Interval between job progress ticks. */
  tickMs?: number;
  /** Artificial latency for every request; 0 resolves on the next microtask. */
  latencyMs?: number;
  /** Seed the demo projects (default true). */
  seed?: boolean;
  /** Override slide art generation (tests use the SVG renderer). */
  renderSlide?: SlideRenderer;
}

type AssetField = "script" | "audio" | "avatar" | "subtitle";

interface PlanStep {
  message: string;
  run: () => void;
}

interface JobPlan {
  steps: PlanStep[];
  onCancel?: () => void;
  onDone?: () => Record<string, unknown> | void;
}

interface Runner {
  job: Job;
  plan: JobPlan;
  next: number;
  timer: ReturnType<typeof setInterval>;
}

interface ProjectState {
  detail: ProjectDetail;
  jobs: Job[];
  revisions: Record<string, ScriptRevision[]>;
  /** Lazily produced URLs for assets (slide art is drawn on first request). */
  urlFactories: Map<string, () => string>;
  urlCache: Map<string, string>;
}

const SLIDE_W = 1280;
const SLIDE_H = 720;
const THUMB_W = 320;
const THUMB_H = 180;
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = randomHex(32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function randomHex(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function missing(): SceneAssetState {
  return { status: "missing" };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

function textDataUrl(text: string, mime = "text/plain"): string {
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
}

/**
 * In-memory implementation of {@link ApiClient} for demos and tests (VITE_API_MOCK=1, or when the
 * API is unreachable). Jobs progress on a timer and emit the same events as the real SSE stream.
 */
export class MockApiClient implements ApiClient {
  readonly mode = "mock" as const;

  private readonly tickMs: number;
  private readonly latencyMs: number;
  private readonly renderSlide: SlideRenderer;
  private readonly projects = new Map<string, ProjectState>();
  private readonly listeners = new Map<string, Set<ProjectEventListener>>();
  private readonly runners = new Map<string, Runner>();
  private providers: ProviderInfo[] = clone(MOCK_PROVIDERS);

  constructor(options: MockApiOptions = {}) {
    this.tickMs = options.tickMs ?? 700;
    this.latencyMs = options.latencyMs ?? 0;
    this.renderSlide = options.renderSlide ?? renderSlideArt;
    if (options.seed ?? true) this.seed();
  }

  /** Stops every running job timer. */
  dispose(): void {
    for (const r of this.runners.values()) clearInterval(r.timer);
    this.runners.clear();
  }

  /** The id of the seeded demo project (first one created). */
  get demoProjectId(): string | undefined {
    return this.projects.keys().next().value;
  }

  // =================================================================== infra

  private async wait(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private state(projectId: string): ProjectState {
    const ps = this.projects.get(projectId);
    if (!ps) throw new ApiRequestError("Project not found", 404, "not_found");
    return ps;
  }

  private emit(ps: ProjectState, event: ProjectEvent): void {
    const set = this.listeners.get(ps.detail.project.id);
    if (!set) return;
    for (const l of [...set]) l(clone(event));
  }

  /** A user-visible change: bump `updatedAt` and recompute the duration. */
  private touch(ps: ProjectState): void {
    ps.detail.project.updatedAt = nowIso();
    this.recompute(ps);
  }

  private recompute(ps: ProjectState): void {
    ps.detail.totalDurationSec = computeTotalDuration(ps.detail.slides, ps.detail.scenes);
  }

  private scene(ps: ProjectState, sceneId: string): Scene {
    const scene = ps.detail.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new ApiRequestError("Scene not found", 404, "not_found");
    return scene;
  }

  private slideOf(ps: ProjectState, scene: Scene): Slide | undefined {
    return ps.detail.slides.find((s) => s.id === scene.slideId);
  }

  private addAsset(
    ps: ProjectState,
    asset: Omit<Asset, "id" | "projectId" | "createdAt" | "storageKey" | "producedBy"> & {
      producedBy?: Asset["producedBy"];
    },
    url: () => string,
  ): Asset {
    const id = uuid();
    const { producedBy, ...rest } = asset;
    const full: Asset = {
      ...rest,
      id,
      projectId: ps.detail.project.id,
      storageKey: `mock/${ps.detail.project.id}/${asset.kind}/${id}`,
      createdAt: nowIso(),
      producedBy: producedBy ?? {},
    };
    ps.detail.assets[id] = full;
    ps.urlFactories.set(id, url);
    return full;
  }

  // ==================================================================== seed

  private newProjectState(project: Project): ProjectState {
    return {
      detail: {
        project,
        slides: [],
        scenes: [],
        scripts: {},
        assets: {},
        activeJobs: [],
        totalDurationSec: 0,
      },
      jobs: [],
      revisions: {},
      urlFactories: new Map(),
      urlCache: new Map(),
    };
  }

  private makeProject(name: string, settings: unknown): Project {
    const ts = nowIso();
    return { id: uuid(), ownerId: "dev", name, settings: ProjectSettings.parse(settings ?? {}), createdAt: ts, updatedAt: ts };
  }

  private seed(): void {
    const project = this.makeProject(DEMO_PROJECT_NAME, {
      avatar: { enabled: true, providerId: "mock", avatarId: "silhouette" },
      targetDurationSec: 600,
      styleNote: "大學部必修課，語氣親切、避免過多英文縮寫。",
    });
    const ps = this.newProjectState(project);
    this.projects.set(project.id, ps);

    const source = this.makeSource(ps, DEMO_SOURCE_FILENAME, 2_480_312);
    source.parseStatus = "succeeded";
    source.pageCount = FIXTURE_SLIDES.length;
    ps.detail.sourceDocument = source;
    this.buildSlides(ps, source, FIXTURE_SLIDES);

    const scenes = ps.detail.scenes;
    // Pages 1–3 have scripts. Page 3 was edited after its audio was made, so audio is stale.
    FIXTURE_SCRIPTS.forEach((text, i) => {
      const scene = scenes[i];
      if (!scene) return;
      if (i === 2) this.addRevision(ps, scene, FIXTURE_PAGE3_V1, "ai");
      this.addRevision(ps, scene, text, i === 2 ? "user" : "ai");
      scene.script = { status: "ready", inputHash: randomHex(64) };
    });
    for (const i of [0, 1, 2]) {
      const scene = scenes[i];
      if (scene) this.finishAudio(ps, scene, undefined, false);
    }
    const page3 = scenes[2];
    if (page3) {
      page3.audio.status = "stale";
      page3.subtitle.status = "stale";
    }

    ps.detail.outline = this.makeOutline(ps);
    this.touch(ps);

    // A job that is already running when the editor opens: scripts for pages 4–6.
    this.startJob(ps, { type: "generate_script", sceneIds: scenes.slice(3).map((s) => s.id), force: false });

    // A second, empty project to demo the upload drop zone.
    const empty = this.makeProject("未命名的專案", { language: "zh-TW" });
    this.projects.set(empty.id, this.newProjectState(empty));
  }

  private makeSource(ps: ProjectState, filename: string, sizeBytes: number): SourceDocument {
    const ext = filename.split(".").pop()?.toLowerCase();
    const kind = ext === "pdf" ? "pdf" : ext === "ppt" ? "ppt" : "pptx";
    const mime =
      kind === "pdf"
        ? "application/pdf"
        : kind === "ppt"
          ? "application/vnd.ms-powerpoint"
          : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return {
      id: uuid(),
      projectId: ps.detail.project.id,
      filename,
      mimeType: mime,
      kind,
      storageKey: `mock/${ps.detail.project.id}/source/${filename}`,
      sizeBytes,
      sha256: randomHex(64),
      version: (ps.detail.sourceDocument?.version ?? 0) + 1,
      parseStatus: "queued",
      createdAt: nowIso(),
    };
  }

  private buildSlides(ps: ProjectState, source: SourceDocument, pages: FixtureSlide[]): void {
    const projectId = ps.detail.project.id;
    ps.detail.slides = [];
    ps.detail.scenes = [];
    pages.forEach((page, index) => {
      const pageNumber = index + 1;
      const hue = (210 + index * 37) % 360;
      const art = { pageNumber, title: page.title, bullets: page.bullets, hue };
      const image = this.addAsset(
        ps,
        { kind: "slide_image", mimeType: "image/png", sizeBytes: 180_000, width: SLIDE_W, height: SLIDE_H },
        () => this.renderSlide({ ...art, width: SLIDE_W, height: SLIDE_H }),
      );
      const thumb = this.addAsset(
        ps,
        { kind: "thumbnail", mimeType: "image/png", sizeBytes: 14_000, width: THUMB_W, height: THUMB_H },
        () => this.renderSlide({ ...art, width: THUMB_W, height: THUMB_H }),
      );
      const plainText = [page.title, ...page.bullets].join("\n");
      const slide: Slide = {
        id: uuid(),
        projectId,
        sourceDocumentId: source.id,
        index,
        pageNumber,
        contentHash: randomHex(64),
        imageAssetId: image.id,
        thumbnailAssetId: thumb.id,
        hidden: false,
        content: {
          pageNumber,
          title: page.title,
          textBlocks: [
            { text: page.title, role: "title", level: 0 },
            ...page.bullets.map((b) => ({ text: b, role: "bullet" as const, level: 0 })),
          ],
          ...(page.notes ? { notes: page.notes } : {}),
          tables: [],
          images: [],
          charts: [],
          plainText,
          hasText: true,
          needsOcr: false,
          widthPt: 960,
          heightPt: 540,
          renderFidelity: "native",
        },
      };
      ps.detail.slides.push(slide);
      ps.detail.scenes.push({
        id: uuid(),
        projectId,
        slideId: slide.id,
        index,
        muted: false,
        tailPauseSec: 0.5,
        script: missing(),
        audio: missing(),
        avatar: missing(),
        subtitle: missing(),
      });
    });
  }

  private makeOutline(ps: ProjectState): OutlineRevision {
    const slides = sortByIndex(ps.detail.slides);
    const idFor = (page: number) => slides[page - 1]?.id;
    const sections = FIXTURE_SECTIONS.map((s) => ({
      title: s.title,
      slideIds: s.pages.map(idFor).filter((id): id is string => id !== undefined),
      keyPoints: s.keyPoints,
    }));
    const timeAllocation: Record<string, number> = {};
    for (const s of slides) timeAllocation[s.id] = 90;
    return {
      id: uuid(),
      projectId: ps.detail.project.id,
      version: (ps.detail.outline?.version ?? 0) + 1,
      objectives: FIXTURE_OBJECTIVES,
      summary: FIXTURE_SUMMARY,
      sections,
      glossary: FIXTURE_GLOSSARY,
      timeAllocation,
      inputHash: randomHex(64),
      createdAt: nowIso(),
    };
  }

  private addRevision(ps: ProjectState, scene: Scene, script: string, source: "ai" | "user"): ScriptRevision {
    const history = (ps.revisions[scene.id] ??= []);
    const glossary = ps.detail.outline?.glossary ?? FIXTURE_GLOSSARY;
    const rev: ScriptRevision = {
      id: uuid(),
      sceneId: scene.id,
      version: (history[history.length - 1]?.version ?? 0) + 1,
      script,
      pronunciationText: derivePronunciation(script, glossary),
      subtitleText: deriveSubtitle(script),
      source,
      contentHash: randomHex(64),
      estimatedDurationSec: estimateSpeechSeconds(script, ps.detail.project.settings.language),
      createdAt: nowIso(),
      ...(ps.detail.outline ? { outlineRevisionId: ps.detail.outline.id } : {}),
    };
    history.push(rev);
    ps.detail.scripts[scene.id] = rev;
    scene.scriptRevisionId = rev.id;
    return rev;
  }

  private markDownstreamStale(scene: Scene, fields: AssetField[]): void {
    for (const f of fields) if (scene[f].status === "ready") scene[f] = { ...scene[f], status: "stale" };
  }

  // ======================================================== job completion

  private finishScript(ps: ProjectState, scene: Scene, jobId: string): void {
    const slide = this.slideOf(ps, scene);
    const fixture: FixtureSlide = {
      title: slide?.content.title ?? `第 ${scene.index + 1} 頁`,
      bullets: slide?.content.textBlocks.filter((b) => b.role === "bullet").map((b) => b.text) ?? [],
    };
    const rev = this.addRevision(ps, scene, mockScriptFor(fixture, scene.index + 1), "ai");
    scene.script = { status: "ready", inputHash: randomHex(64), jobId };
    this.markDownstreamStale(scene, ["audio", "subtitle", "avatar"]);
    this.emit(ps, { kind: "script", script: rev });
    this.emit(ps, { kind: "scene", scene });
  }

  private finishAudio(ps: ProjectState, scene: Scene, jobId: string | undefined, emit = true): void {
    const durationSec = 1;
    const freq = 330 + scene.index * 55;
    const producedBy = jobId ? { jobId, providerId: ps.detail.project.settings.voice.providerId } : {};
    const audio = this.addAsset(
      ps,
      { kind: "audio", mimeType: "audio/wav", sizeBytes: 32_044, durationSec, inputHash: randomHex(64), producedBy },
      () => toneWavDataUrl(freq, durationSec),
    );
    const text = ps.detail.scripts[scene.id]?.subtitleText ?? "";
    const srt = `1\n${srtTime(0)} --> ${srtTime(durationSec)}\n${text}\n`;
    const subtitle = this.addAsset(
      ps,
      { kind: "subtitle", mimeType: "application/x-subrip", sizeBytes: srt.length, inputHash: randomHex(64), producedBy },
      () => textDataUrl(srt, "application/x-subrip"),
    );
    scene.audio = { status: "ready", assetId: audio.id, inputHash: audio.inputHash, ...(jobId ? { jobId } : {}) };
    scene.subtitle = { status: "ready", assetId: subtitle.id, inputHash: subtitle.inputHash };
    scene.durationSec = durationSec;
    this.markDownstreamStale(scene, ["avatar"]);
    this.recompute(ps);
    if (emit) {
      this.emit(ps, { kind: "asset", asset: audio });
      this.emit(ps, { kind: "asset", asset: subtitle });
      this.emit(ps, { kind: "scene", scene });
    }
  }

  private finishAvatar(ps: ProjectState, scene: Scene, jobId: string): void {
    const settings = ps.detail.project.settings;
    const asset = this.addAsset(
      ps,
      {
        kind: "avatar_video",
        mimeType: "image/svg+xml",
        sizeBytes: 600,
        durationSec: scene.durationSec ?? 1,
        inputHash: randomHex(64),
        producedBy: { jobId, ...(settings.avatar.providerId ? { providerId: settings.avatar.providerId } : {}) },
      },
      () => avatarPlaceholderSvg(200 + scene.index * 20),
    );
    scene.avatar = { status: "ready", assetId: asset.id, inputHash: asset.inputHash, jobId };
    this.emit(ps, { kind: "asset", asset });
    this.emit(ps, { kind: "scene", scene });
  }

  private finishRender(ps: ProjectState, jobId: string): Record<string, unknown> {
    const visible = this.visibleScenes(ps);
    let t = 0;
    const cues: string[] = [];
    visible.forEach((scene) => {
      const text = ps.detail.scripts[scene.id]?.subtitleText;
      const d = (scene.durationSec ?? 2) + scene.tailPauseSec;
      if (text) cues.push(`${cues.length + 1}\n${srtTime(t)} --> ${srtTime(t + d - scene.tailPauseSec)}\n${text}\n`);
      t += d;
    });
    const srtText = cues.join("\n");
    const video = this.addAsset(
      ps,
      {
        kind: "video",
        mimeType: "video/mp4",
        sizeBytes: 1_250_000,
        durationSec: t,
        width: 1920,
        height: 1080,
        producedBy: { jobId },
      },
      () => textDataUrl("This is a placeholder produced by the mock API; the real API renders an MP4 here.\n"),
    );
    const srt = this.addAsset(
      ps,
      { kind: "subtitle", mimeType: "application/x-subrip", sizeBytes: srtText.length, producedBy: { jobId } },
      () => textDataUrl(srtText, "application/x-subrip"),
    );
    this.emit(ps, { kind: "asset", asset: video });
    this.emit(ps, { kind: "asset", asset: srt });
    return { videoAssetId: video.id, srtAssetId: srt.id };
  }

  private visibleScenes(ps: ProjectState): Scene[] {
    const hidden = new Set(ps.detail.slides.filter((s) => s.hidden).map((s) => s.id));
    return sortByIndex(ps.detail.scenes).filter((s) => !hidden.has(s.slideId));
  }

  // ============================================================ job engine

  private startJob(ps: ProjectState, payload: JobPayload): Job {
    const job: Job = {
      id: uuid(),
      projectId: ps.detail.project.id,
      type: payload.type,
      status: "queued",
      payload,
      attempts: 0,
      maxAttempts: 3,
      progress: 0,
      createdAt: nowIso(),
    };
    ps.jobs.unshift(job);
    ps.detail.activeJobs.push(job);
    const plan = this.planFor(ps, job);
    this.emit(ps, { kind: "job", job });
    const runner: Runner = { job, plan, next: 0, timer: setInterval(() => this.tick(ps, runner), this.tickMs) };
    this.runners.set(job.id, runner);
    return job;
  }

  private tick(ps: ProjectState, runner: Runner): void {
    const { job, plan } = runner;
    if (job.status === "queued") {
      job.status = "running";
      job.startedAt = nowIso();
      job.attempts = 1;
    }
    const step = plan.steps[runner.next];
    if (step) {
      step.run();
      runner.next += 1;
      job.progress = Math.min(0.99, runner.next / plan.steps.length);
      job.progressMessage = step.message;
      this.emit(ps, { kind: "job", job });
      if (runner.next < plan.steps.length) return;
    }
    // Done.
    clearInterval(runner.timer);
    this.runners.delete(job.id);
    const result = plan.onDone?.();
    if (result) job.result = result;
    job.status = "succeeded";
    job.progress = 1;
    job.finishedAt = nowIso();
    delete job.progressMessage;
    ps.detail.activeJobs = ps.detail.activeJobs.filter((j) => j.id !== job.id);
    this.recompute(ps);
    this.emit(ps, { kind: "job", job });
  }

  private planFor(ps: ProjectState, job: Job): JobPlan {
    const p = job.payload;
    switch (p.type) {
      case "generate_script": {
        const targets = this.targets(ps, p.sceneIds, p.force, (s) => ["missing", "stale", "failed"].includes(s.script.status));
        return this.perScenePlan(ps, job, "script", targets, "撰寫講稿", (s) => this.finishScript(ps, s, job.id));
      }
      case "synthesize_speech": {
        const targets = this.targets(
          ps,
          p.sceneIds,
          p.force,
          (s) => s.script.status === "ready" && !s.muted && ["missing", "stale", "failed"].includes(s.audio.status),
        ).filter((s) => ps.detail.scripts[s.id]);
        return this.perScenePlan(ps, job, "audio", targets, "合成語音", (s) => this.finishAudio(ps, s, job.id));
      }
      case "generate_avatar": {
        const targets = this.targets(
          ps,
          p.sceneIds,
          p.force,
          (s) => s.audio.status === "ready" && ["missing", "stale", "failed"].includes(s.avatar.status),
        ).filter((s) => s.audio.status === "ready");
        return this.perScenePlan(ps, job, "avatar", targets, "產生人像", (s) => this.finishAvatar(ps, s, job.id));
      }
      case "render_video": {
        const steps: PlanStep[] = this.visibleScenes(ps).map((s) => ({
          message: `合成第 ${s.index + 1} 頁`,
          run: () => undefined,
        }));
        steps.push({ message: "輸出 MP4 與 SRT", run: () => undefined });
        return { steps, onDone: () => this.finishRender(ps, job.id) };
      }
      case "generate_outline":
        return {
          steps: [
            { message: "分析全部頁面", run: () => undefined },
            { message: "規劃段落與時間", run: () => undefined },
            {
              message: "整理術語表",
              run: () => {
                ps.detail.outline = this.makeOutline(ps);
                this.emit(ps, { kind: "outline", outline: ps.detail.outline });
              },
            },
          ],
        };
      case "parse_document":
        return this.parsePlan(ps, p.sourceDocumentId);
      case "export_script":
        return {
          steps: [{ message: "匯出講稿", run: () => undefined }],
          onDone: () => {
            const text = this.scriptExportText(ps, p.format === "md" ? "md" : "txt");
            const asset = this.addAsset(
              ps,
              { kind: "script_export", mimeType: "text/plain", sizeBytes: text.length, producedBy: { jobId: job.id } },
              () => textDataUrl(text),
            );
            this.emit(ps, { kind: "asset", asset });
            return { assetId: asset.id };
          },
        };
    }
  }

  private targets(ps: ProjectState, sceneIds: string[] | undefined, force: boolean, needs: (s: Scene) => boolean): Scene[] {
    const all = sortByIndex(ps.detail.scenes);
    if (sceneIds) return all.filter((s) => sceneIds.includes(s.id));
    return force ? all : all.filter(needs);
  }

  /** Queue `field` on every target, then two ticks per scene: generating → ready. */
  private perScenePlan(
    ps: ProjectState,
    job: Job,
    field: AssetField,
    targets: Scene[],
    verb: string,
    finish: (scene: Scene) => void,
  ): JobPlan {
    const previous = new Map<string, SceneAssetState>();
    for (const scene of targets) {
      previous.set(scene.id, scene[field]);
      scene[field] = { ...scene[field], status: "queued", jobId: job.id };
      this.emit(ps, { kind: "scene", scene });
    }
    const steps: PlanStep[] = targets.flatMap((scene) => [
      {
        message: `第 ${scene.index + 1} 頁：${verb}中`,
        run: () => {
          scene[field] = { ...scene[field], status: "generating" };
          this.emit(ps, { kind: "scene", scene });
        },
      },
      { message: `第 ${scene.index + 1} 頁：完成`, run: () => finish(scene) },
    ]);
    return {
      steps,
      onCancel: () => {
        for (const scene of targets) {
          const st = scene[field].status;
          if (st !== "queued" && st !== "generating") continue;
          scene[field] = previous.get(scene.id) ?? missing();
          this.emit(ps, { kind: "scene", scene });
        }
      },
    };
  }

  private parsePlan(ps: ProjectState, sourceDocumentId: string): JobPlan {
    const pageCount = 5;
    const steps: PlanStep[] = [{ message: "檢查檔案格式", run: () => undefined }];
    for (let i = 1; i <= pageCount; i++) steps.push({ message: `轉換頁面 ${i}/${pageCount}`, run: () => undefined });
    steps.push({
      message: "擷取文字與備忘稿",
      run: () => {
        const source = ps.detail.sourceDocument;
        if (!source || source.id !== sourceDocumentId) return;
        const base = source.filename.replace(/\.[^.]+$/, "");
        const pages: FixtureSlide[] = Array.from({ length: pageCount }, (_, i) => ({
          title: i === 0 ? base : `${base}（第 ${i + 1} 頁）`,
          bullets: ["重點一", "重點二", "重點三"],
        }));
        this.buildSlides(ps, source, pages);
        source.parseStatus = "succeeded";
        source.pageCount = pageCount;
        this.touch(ps);
        this.emit(ps, { kind: "slides", slides: ps.detail.slides, scenes: ps.detail.scenes });
        this.emit(ps, { kind: "project", project: ps.detail.project });
      },
    });
    return {
      steps,
      onCancel: () => {
        const source = ps.detail.sourceDocument;
        if (source?.id === sourceDocumentId) source.parseStatus = "cancelled";
      },
    };
  }

  // ============================================================== health

  async health(): Promise<HealthResponse> {
    await this.wait();
    return { ok: true, version: "mock" };
  }

  // =========================================================== providers

  async listProviders(): Promise<ProviderInfo[]> {
    await this.wait();
    return clone(this.providers);
  }

  private setConfigured(providerId: string, configured: boolean): ProviderInfo {
    const matches = this.providers.filter((p) => p.id === providerId);
    const first = matches[0];
    if (!first) throw new ApiRequestError("Unknown provider", 404, "not_found");
    for (const p of matches) p.configured = configured || !p.requiresApiKey;
    return clone(first);
  }

  async setProviderKey(providerId: string, req: SetProviderKeyRequest): Promise<ProviderInfo> {
    await this.wait();
    if (!req.apiKey.trim()) throw new ApiRequestError("API key is empty", 400, "invalid_request");
    return this.setConfigured(providerId, true);
  }

  async deleteProviderKey(providerId: string): Promise<ProviderInfo> {
    await this.wait();
    return this.setConfigured(providerId, false);
  }

  async previewVoice(): Promise<Blob> {
    await this.wait();
    const dataUrl = toneWavDataUrl();
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: "audio/wav" });
  }

  async listVoices(providerId: string): Promise<VoiceOption[]> {
    await this.wait();
    return clone(MOCK_VOICES[providerId] ?? []);
  }

  async listAvatars(providerId: string): Promise<AvatarOption[]> {
    await this.wait();
    return clone(MOCK_AVATARS[providerId] ?? []);
  }

  // ============================================================ projects

  async listProjects(): Promise<ProjectSummary[]> {
    await this.wait();
    return [...this.projects.values()]
      .map((ps) => ({
        ...clone(ps.detail.project),
        ...(ps.detail.sourceDocument ? { pageCount: ps.detail.slides.length } : {}),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createProject(req: CreateProjectRequest): Promise<Project> {
    await this.wait();
    const project = this.makeProject(req.name, req.settings ?? {});
    this.projects.set(project.id, this.newProjectState(project));
    return clone(project);
  }

  async getProject(projectId: string): Promise<ProjectDetail> {
    await this.wait();
    return clone(this.state(projectId).detail);
  }

  async updateProject(projectId: string, req: UpdateProjectRequest): Promise<Project> {
    await this.wait();
    const ps = this.state(projectId);
    const project = ps.detail.project;
    const before = project.settings;
    if (req.name !== undefined) project.name = req.name;
    if (req.settings) {
      project.settings = ProjectSettings.parse(deepMerge(before, req.settings));
      this.invalidateForSettings(ps, before, project.settings);
    }
    this.touch(ps);
    this.emit(ps, { kind: "project", project });
    return clone(project);
  }

  /** Mirrors the API's hash rules for the settings that affect per-scene assets. */
  private invalidateForSettings(ps: ProjectState, before: ProjectSettings, after: ProjectSettings): void {
    const voiceChanged = JSON.stringify(before.voice) !== JSON.stringify(after.voice) || before.language !== after.language;
    const avatarChanged =
      before.avatar.providerId !== after.avatar.providerId ||
      before.avatar.avatarId !== after.avatar.avatarId ||
      before.aspectRatio !== after.aspectRatio;
    const subtitleChanged = before.subtitles.style.maxCharsPerLine !== after.subtitles.style.maxCharsPerLine;
    if (!voiceChanged && !avatarChanged && !subtitleChanged) return;
    for (const scene of ps.detail.scenes) {
      const fields: AssetField[] = [];
      if (voiceChanged) fields.push("audio", "subtitle", "avatar");
      if (avatarChanged) fields.push("avatar");
      if (subtitleChanged) fields.push("subtitle");
      const beforeJson = JSON.stringify(scene);
      this.markDownstreamStale(scene, fields);
      if (JSON.stringify(scene) !== beforeJson) this.emit(ps, { kind: "scene", scene });
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.wait();
    const ps = this.state(projectId);
    for (const job of ps.detail.activeJobs) {
      const r = this.runners.get(job.id);
      if (r) clearInterval(r.timer);
      this.runners.delete(job.id);
    }
    this.projects.delete(projectId);
  }

  // ============================================================== source

  async uploadSource(projectId: string, file: File, options: UploadOptions = {}): Promise<UploadSourceResponse> {
    const ps = this.state(projectId);
    if (!/\.(pptx|ppt|pdf)$/i.test(file.name)) {
      throw new ApiRequestError("Unsupported file type", 415, "unsupported_media_type");
    }
    for (let i = 1; i <= 4; i++) {
      await new Promise((r) => setTimeout(r, Math.max(20, this.latencyMs / 2)));
      options.onProgress?.(i / 4);
    }
    const source = this.makeSource(ps, file.name, file.size);
    ps.detail.sourceDocument = source;
    const job = this.startJob(ps, { type: "parse_document", sourceDocumentId: source.id });
    source.parseJobId = job.id;
    this.touch(ps);
    return clone({ sourceDocument: source, job });
  }

  // ====================================================== slides/scenes

  async reorderSlides(projectId: string, req: ReorderSlidesRequest): Promise<ReorderSlidesResponse> {
    await this.wait();
    const ps = this.state(projectId);
    const { slides, scenes } = ps.detail;
    if (req.slideIds.length !== slides.length || !slides.every((s) => req.slideIds.includes(s.id))) {
      throw new ApiRequestError("slideIds must list every slide exactly once", 400, "invalid_request");
    }
    req.slideIds.forEach((id, index) => {
      const slide = slides.find((s) => s.id === id);
      if (slide) slide.index = index;
      const scene = scenes.find((s) => s.slideId === id);
      if (scene) scene.index = index;
    });
    ps.detail.slides = sortByIndex(slides);
    ps.detail.scenes = sortByIndex(scenes);
    this.touch(ps);
    this.emit(ps, { kind: "slides", slides: ps.detail.slides, scenes: ps.detail.scenes });
    return clone({ slides: ps.detail.slides, scenes: ps.detail.scenes });
  }

  async setSlideHidden(projectId: string, slideId: string, hidden: boolean): Promise<Slide> {
    await this.wait();
    const ps = this.state(projectId);
    const slide = ps.detail.slides.find((s) => s.id === slideId);
    if (!slide) throw new ApiRequestError("Slide not found", 404, "not_found");
    slide.hidden = hidden;
    this.touch(ps);
    this.emit(ps, { kind: "slides", slides: ps.detail.slides, scenes: ps.detail.scenes });
    return clone(slide);
  }

  async updateScene(projectId: string, sceneId: string, req: UpdateSceneRequest): Promise<Scene> {
    await this.wait();
    const ps = this.state(projectId);
    const scene = this.scene(ps, sceneId);
    if (req.muted !== undefined) scene.muted = req.muted;
    if (req.tailPauseSec !== undefined) scene.tailPauseSec = req.tailPauseSec;
    if (req.avatarLayout === null) delete scene.avatarLayout;
    else if (req.avatarLayout) scene.avatarLayout = req.avatarLayout;
    if (req.transitionIn === null) delete scene.transitionIn;
    else if (req.transitionIn) scene.transitionIn = req.transitionIn;
    this.touch(ps);
    this.emit(ps, { kind: "scene", scene });
    return clone(scene);
  }

  async updateScript(projectId: string, sceneId: string, req: UpdateScriptRequest): Promise<ScriptRevision> {
    await this.wait();
    const ps = this.state(projectId);
    const scene = this.scene(ps, sceneId);
    const latest = ps.detail.scripts[sceneId];
    if (latest && latest.script === req.script) return clone(latest);
    const rev = this.addRevision(ps, scene, req.script, "user");
    if (req.pronunciationText !== undefined) rev.pronunciationText = req.pronunciationText;
    if (req.subtitleText !== undefined) rev.subtitleText = req.subtitleText;
    scene.script = { status: req.script.trim() ? "ready" : "missing", inputHash: randomHex(64) };
    this.markDownstreamStale(scene, ["audio", "subtitle", "avatar"]);
    this.touch(ps);
    this.emit(ps, { kind: "script", script: rev });
    this.emit(ps, { kind: "scene", scene });
    return clone(rev);
  }

  async listScriptRevisions(projectId: string, sceneId: string): Promise<ScriptRevision[]> {
    await this.wait();
    const ps = this.state(projectId);
    return clone([...(ps.revisions[sceneId] ?? [])].reverse());
  }

  // ================================================================ jobs

  async enqueueJob(projectId: string, req: EnqueueJobRequest): Promise<EnqueueJobResponse> {
    await this.wait();
    const ps = this.state(projectId);
    const estimateType: EstimateType | undefined =
      req.type === "synthesize_speech" || req.type === "generate_avatar" || req.type === "render_video" ? req.type : undefined;
    const estimate = estimateType ? this.estimate(ps, estimateType) : undefined;
    const job = this.startJob(ps, req);
    return clone({ job, ...(estimate ? { estimate } : {}) });
  }

  async listJobs(projectId: string, status?: JobStatus): Promise<Job[]> {
    await this.wait();
    const ps = this.state(projectId);
    return clone(status ? ps.jobs.filter((j) => j.status === status) : ps.jobs);
  }

  async cancelJob(projectId: string, jobId: string): Promise<Job> {
    await this.wait();
    const ps = this.state(projectId);
    const job = ps.jobs.find((j) => j.id === jobId);
    if (!job) throw new ApiRequestError("Job not found", 404, "not_found");
    const runner = this.runners.get(jobId);
    if (runner && (job.status === "queued" || job.status === "running")) {
      clearInterval(runner.timer);
      this.runners.delete(jobId);
      runner.plan.onCancel?.();
      job.status = "cancelled";
      job.finishedAt = nowIso();
      delete job.progressMessage;
      ps.detail.activeJobs = ps.detail.activeJobs.filter((j) => j.id !== jobId);
      this.emit(ps, { kind: "job", job });
    }
    return clone(job);
  }

  // ===================================================== estimate/export

  private estimate(ps: ProjectState, type: EstimateType): CostEstimate {
    const settings = ps.detail.project.settings;
    const scenes = this.visibleScenes(ps);
    if (type === "synthesize_speech") {
      const chars = scenes
        .filter((s) => !s.muted && s.audio.status !== "ready")
        .reduce((n, s) => n + Array.from(ps.detail.scripts[s.id]?.pronunciationText ?? "").length, 0);
      const cost = round(chars * MOCK_PRICES.ttsPerChar);
      return {
        lines: [{ providerId: settings.voice.providerId, unit: "chars", quantity: chars, estimatedCost: cost }],
        total: cost,
        currency: "USD",
      };
    }
    if (type === "generate_avatar") {
      const seconds = scenes
        .filter((s) => !s.muted && s.avatar.status !== "ready")
        .reduce((n, s) => n + (s.durationSec ?? ps.detail.scripts[s.id]?.estimatedDurationSec ?? 0), 0);
      const cost = round(seconds * MOCK_PRICES.avatarPerSecond);
      const providerId = settings.avatar.providerId ?? "avatar";
      return {
        lines: [{ providerId, unit: "avatar_seconds", quantity: seconds, estimatedCost: cost }],
        total: cost,
        currency: "USD",
      };
    }
    const seconds = ps.detail.totalDurationSec;
    return {
      lines: [{ providerId: "render", unit: "render_seconds", quantity: seconds, estimatedCost: 0 }],
      total: 0,
      currency: "USD",
    };
  }

  async getEstimate(projectId: string, type: EstimateType): Promise<CostEstimate> {
    await this.wait();
    return this.estimate(this.state(projectId), type);
  }

  private scriptExportText(ps: ProjectState, format: ScriptExportFormat): string {
    const lines: string[] = format === "md" ? [`# ${ps.detail.project.name}`, ""] : [ps.detail.project.name, ""];
    for (const scene of this.visibleScenes(ps)) {
      const slide = this.slideOf(ps, scene);
      const title = `第 ${scene.index + 1} 頁${slide?.content.title ? `：${slide.content.title}` : ""}`;
      const text = ps.detail.scripts[scene.id]?.script ?? "";
      lines.push(format === "md" ? `## ${title}` : `【${title}】`, "", text, "");
    }
    return lines.join("\n");
  }

  async exportScript(projectId: string, format: ScriptExportFormat): Promise<Blob> {
    await this.wait();
    const text = this.scriptExportText(this.state(projectId), format);
    return new Blob([text], { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" });
  }

  async getAssetUrl(projectId: string, assetId: string): Promise<AssetUrlResponse> {
    await this.wait();
    const ps = this.state(projectId);
    let url = ps.urlCache.get(assetId);
    if (!url) {
      const factory = ps.urlFactories.get(assetId);
      if (!factory) throw new ApiRequestError("Asset not found", 404, "not_found");
      url = factory();
      ps.urlCache.set(assetId, url);
    }
    return { url, expiresAt: FAR_FUTURE };
  }

  // ============================================================== events

  subscribe(projectId: string, listener: ProjectEventListener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) {
      set = new Set();
      this.listeners.set(projectId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
