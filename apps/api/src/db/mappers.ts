import type {
  Asset,
  Job,
  JobStatus,
  JobType,
  OutlineRevision,
  Project,
  Scene,
  ScriptRevision,
  Slide,
  SourceDocument,
  Transition,
  UsageRecord,
} from "@lvs/shared";
import type {
  AssetRow,
  JobRow,
  OutlineRevisionRow,
  ProjectRow,
  SceneRow,
  ScriptRevisionRow,
  SlideRow,
  SourceDocumentRow,
  UsageRecordRow,
} from "./schema.js";

const iso = (d: Date) => d.toISOString();
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  ownerId: r.ownerId,
  name: r.name,
  settings: r.settings,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

export const toSourceDocument = (r: SourceDocumentRow): SourceDocument => ({
  id: r.id,
  projectId: r.projectId,
  filename: r.filename,
  mimeType: r.mimeType,
  kind: r.kind as SourceDocument["kind"],
  storageKey: r.storageKey,
  sizeBytes: r.sizeBytes,
  sha256: r.sha256,
  version: r.version,
  parseStatus: r.parseStatus as JobStatus,
  parseJobId: opt(r.parseJobId),
  pageCount: opt(r.pageCount),
  createdAt: iso(r.createdAt),
});

export const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  projectId: r.projectId,
  kind: r.kind as Asset["kind"],
  storageKey: r.storageKey,
  mimeType: r.mimeType,
  sizeBytes: r.sizeBytes,
  durationSec: opt(r.durationSec),
  width: opt(r.width),
  height: opt(r.height),
  inputHash: opt(r.inputHash),
  producedBy: r.producedBy ?? {},
  createdAt: iso(r.createdAt),
});

export const toSlide = (r: SlideRow): Slide => ({
  id: r.id,
  projectId: r.projectId,
  sourceDocumentId: r.sourceDocumentId,
  index: r.index,
  pageNumber: r.pageNumber,
  contentHash: r.contentHash,
  imageAssetId: opt(r.imageAssetId),
  thumbnailAssetId: opt(r.thumbnailAssetId),
  content: r.content,
  hidden: r.hidden,
});

export const toScene = (r: SceneRow): Scene => ({
  id: r.id,
  projectId: r.projectId,
  slideId: r.slideId,
  index: r.index,
  muted: r.muted,
  avatarLayout: opt(r.avatarLayout),
  transitionIn: opt(r.transitionIn) as Transition | undefined,
  tailPauseSec: r.tailPauseSec,
  scriptRevisionId: opt(r.scriptRevisionId),
  script: r.script,
  audio: r.audio,
  avatar: r.avatar,
  subtitle: r.subtitle,
  durationSec: opt(r.durationSec),
});

export const toScriptRevision = (r: ScriptRevisionRow): ScriptRevision => ({
  id: r.id,
  sceneId: r.sceneId,
  version: r.version,
  script: r.script,
  pronunciationText: r.pronunciationText,
  subtitleText: r.subtitleText,
  source: r.source as ScriptRevision["source"],
  outlineRevisionId: opt(r.outlineRevisionId),
  contentHash: r.contentHash,
  estimatedDurationSec: opt(r.estimatedDurationSec),
  createdAt: iso(r.createdAt),
});

export const toOutline = (r: OutlineRevisionRow): OutlineRevision => ({
  id: r.id,
  projectId: r.projectId,
  version: r.version,
  objectives: r.objectives,
  summary: r.summary,
  sections: r.sections,
  glossary: r.glossary,
  timeAllocation: r.timeAllocation,
  inputHash: r.inputHash,
  createdAt: iso(r.createdAt),
});

export const toJob = (r: JobRow): Job => ({
  id: r.id,
  projectId: r.projectId,
  type: r.type as JobType,
  status: r.status as JobStatus,
  payload: r.payload,
  result: opt(r.result),
  error: opt(r.error),
  attempts: r.attempts,
  maxAttempts: r.maxAttempts,
  progress: r.progress,
  progressMessage: opt(r.progressMessage),
  providerTaskId: opt(r.providerTaskId),
  dedupeKey: opt(r.dedupeKey),
  createdAt: iso(r.createdAt),
  startedAt: r.startedAt ? iso(r.startedAt) : undefined,
  finishedAt: r.finishedAt ? iso(r.finishedAt) : undefined,
});

export const toUsageRecord = (r: UsageRecordRow): UsageRecord => ({
  id: r.id,
  projectId: r.projectId,
  jobId: opt(r.jobId),
  providerId: r.providerId,
  unit: r.unit as UsageRecord["unit"],
  quantity: r.quantity,
  estimatedCost: opt(r.estimatedCost),
  currency: r.currency,
  createdAt: iso(r.createdAt),
});
