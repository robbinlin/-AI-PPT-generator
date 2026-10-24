import { z } from "zod";
import {
  Job,
  Project,
  Scene,
  Slide,
  SourceDocument,
  Language,
  type CostEstimate,
  type CreateProjectRequest,
  type CreateTranslationRequest,
  type EnqueueJobRequest,
  type EnqueueJobResponse,
  type JobStatus,
  type ProjectDetail,
  type ProjectEvent,
  type ProviderInfo,
  type ReorderSlidesRequest,
  type ScriptRevision,
  type SetProviderKeyRequest,
  type UpdateProjectRequest,
  type UpdateSceneRequest,
  type UpdateScriptRequest,
} from "@lvs/shared";

/*
 * Response shapes that docs/API.md describes inline but `@lvs/shared` does not export as
 * schemas. Kept local until they move into shared (see apps/web/README.md).
 */

export const HealthResponse = z.object({ ok: z.literal(true), version: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const UploadSourceResponse = z.object({ sourceDocument: SourceDocument, job: Job });
export type UploadSourceResponse = z.infer<typeof UploadSourceResponse>;

export const ReorderSlidesResponse = z.object({ slides: z.array(Slide), scenes: z.array(Scene) });
export type ReorderSlidesResponse = z.infer<typeof ReorderSlidesResponse>;

export const CreateTranslationResponse = z.object({ project: Project, job: Job });
export type CreateTranslationResponse = z.infer<typeof CreateTranslationResponse>;

export const AssetUrlResponse = z.object({ url: z.string().min(1), expiresAt: z.string() });
export type AssetUrlResponse = z.infer<typeof AssetUrlResponse>;

/** Zod mirror of the `Voice` interface in `@lvs/shared/providers` (an interface, not a schema). */
export const VoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  languages: z.array(Language),
  gender: z.enum(["female", "male", "neutral"]).optional(),
  previewUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type VoiceOption = z.infer<typeof VoiceSchema>;

/** Zod mirror of the `AvatarCharacter` interface in `@lvs/shared/providers`. */
export const AvatarCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  previewImageUrl: z.string().optional(),
  kind: z.enum(["stock", "personal"]),
  source: z.enum(["photo", "video"]).optional(),
});
export type AvatarOption = z.infer<typeof AvatarCharacterSchema>;

/**
 * `GET /projects` returns `Project[]`, which has no page count. The list view reads an
 * optional `pageCount` if the API adds it (the mock does) and shows "not uploaded" otherwise.
 */
export const ProjectSummary = Project.extend({ pageCount: z.number().int().nonnegative().optional() });
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export type EstimateType = "generate_script" | "synthesize_speech" | "generate_avatar" | "render_video" | "translate_script";
/** `pending` (default): only pages the job would actually process; `all`: a forced regeneration. */
export interface EstimateOptions {
  scope?: "pending" | "all";
  sceneIds?: string[];
}
export type ScriptExportFormat = "txt" | "md";

export interface UploadOptions {
  /** Upload progress, 0..1. */
  onProgress?: (fraction: number) => void;
}

export type ProjectEventListener = (event: ProjectEvent) => void;

/** Typed surface over every route in docs/API.md. Implemented by HttpApiClient and MockApiClient. */
export interface ApiClient {
  readonly mode: "http" | "mock";

  health(): Promise<HealthResponse>;

  listProviders(): Promise<ProviderInfo[]>;
  setProviderKey(providerId: string, req: SetProviderKeyRequest): Promise<ProviderInfo>;
  deleteProviderKey(providerId: string): Promise<ProviderInfo>;
  listVoices(providerId: string): Promise<VoiceOption[]>;
  /** Audio blob of a short sample sentence in the given voice. */
  previewVoice(providerId: string, voiceId: string, language: "zh-TW" | "en"): Promise<Blob>;
  /** Providers with customVoices: upload a reference clip of the user's own voice. */
  uploadVoice(providerId: string, file: File, options?: UploadOptions & { name?: string; transcript?: string }): Promise<VoiceOption>;
  deleteVoice(providerId: string, voiceId: string): Promise<void>;
  /** Providers with customCharacters: upload the user's own photo/video as an avatar character. */
  uploadAvatarCharacter(providerId: string, file: File, options?: UploadOptions): Promise<AvatarOption>;
  deleteAvatarCharacter(providerId: string, characterId: string): Promise<void>;
  /** URL of a character's preview image (served through the API). */
  avatarCharacterPreviewUrl(providerId: string, characterId: string): string;
  listAvatars(providerId: string): Promise<AvatarOption[]>;

  listProjects(): Promise<ProjectSummary[]>;
  createProject(req: CreateProjectRequest): Promise<Project>;
  /** A copy of the project in another language; its scripts are translated by the returned job. */
  createTranslation(projectId: string, req: CreateTranslationRequest): Promise<CreateTranslationResponse>;
  getProject(projectId: string): Promise<ProjectDetail>;
  updateProject(projectId: string, req: UpdateProjectRequest): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;

  uploadSource(projectId: string, file: File, options?: UploadOptions): Promise<UploadSourceResponse>;
  reorderSlides(projectId: string, req: ReorderSlidesRequest): Promise<ReorderSlidesResponse>;
  setSlideHidden(projectId: string, slideId: string, hidden: boolean): Promise<Slide>;
  updateScene(projectId: string, sceneId: string, req: UpdateSceneRequest): Promise<Scene>;
  updateScript(projectId: string, sceneId: string, req: UpdateScriptRequest): Promise<ScriptRevision>;
  listScriptRevisions(projectId: string, sceneId: string): Promise<ScriptRevision[]>;

  enqueueJob(projectId: string, req: EnqueueJobRequest): Promise<EnqueueJobResponse>;
  listJobs(projectId: string, status?: JobStatus): Promise<Job[]>;
  cancelJob(projectId: string, jobId: string): Promise<Job>;

  getEstimate(projectId: string, type: EstimateType, options?: EstimateOptions): Promise<CostEstimate>;
  exportScript(projectId: string, format: ScriptExportFormat): Promise<Blob>;
  getAssetUrl(projectId: string, assetId: string): Promise<AssetUrlResponse>;

  /** Server-sent project events. Returns an unsubscribe function. */
  subscribe(projectId: string, listener: ProjectEventListener): () => void;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
