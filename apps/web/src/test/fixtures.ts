import { ProjectSettings, type Job, type ProjectDetail, type Scene, type ScriptRevision, type Slide } from "@lvs/shared";

let counter = 0;
/** Deterministic, valid UUIDs for tests. */
export function testId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

const TS = "2026-10-01T00:00:00.000Z";

export function makeSlide(projectId: string, index: number, overrides: Partial<Slide> = {}): Slide {
  return {
    id: testId(),
    projectId,
    sourceDocumentId: testId(),
    index,
    pageNumber: index + 1,
    contentHash: `hash-${index}`,
    hidden: false,
    content: {
      pageNumber: index + 1,
      title: `Slide ${index + 1}`,
      textBlocks: [],
      tables: [],
      images: [],
      charts: [],
      plainText: "",
      hasText: true,
      needsOcr: false,
      widthPt: 960,
      heightPt: 540,
      renderFidelity: "native",
    },
    ...overrides,
  };
}

export function makeScene(projectId: string, slide: Slide, overrides: Partial<Scene> = {}): Scene {
  return {
    id: testId(),
    projectId,
    slideId: slide.id,
    index: slide.index,
    muted: false,
    tailPauseSec: 0.5,
    script: { status: "missing" },
    audio: { status: "missing" },
    avatar: { status: "missing" },
    subtitle: { status: "missing" },
    ...overrides,
  };
}

export function makeRevision(sceneId: string, script: string, version = 1, source: "ai" | "user" = "ai"): ScriptRevision {
  return {
    id: testId(),
    sceneId,
    version,
    script,
    pronunciationText: script,
    subtitleText: script,
    source,
    contentHash: `c-${version}`,
    createdAt: TS,
  };
}

export function makeJob(projectId: string, overrides: Partial<Job> = {}): Job {
  return {
    id: testId(),
    projectId,
    type: "generate_script",
    status: "running",
    payload: { type: "generate_script", force: false },
    attempts: 1,
    maxAttempts: 3,
    progress: 0.5,
    createdAt: TS,
    ...overrides,
  };
}

/** A three-page project; page 1 has a script and ready audio. */
export function makeDetail(pages = 3): ProjectDetail {
  const projectId = testId();
  const slides = Array.from({ length: pages }, (_, i) => makeSlide(projectId, i));
  const scenes = slides.map((s) => makeScene(projectId, s));
  const first = scenes[0];
  const scripts: Record<string, ScriptRevision> = {};
  if (first) {
    first.script = { status: "ready" };
    first.audio = { status: "ready", assetId: testId() };
    first.durationSec = 10;
    scripts[first.id] = makeRevision(first.id, "第一頁講稿");
  }
  return {
    project: { id: projectId, ownerId: "dev", name: "Test", settings: ProjectSettings.parse({ avatar: { avatarId: "test-avatar" } }), createdAt: TS, updatedAt: TS },
    slides,
    scenes,
    scripts,
    assets: {},
    activeJobs: [],
    totalDurationSec: 10.5,
    currentRenderHashes: [],
  };
}
