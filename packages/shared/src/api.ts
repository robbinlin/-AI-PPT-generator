import { z } from "zod";
import { Id } from "./ids.js";
import {
  Asset,
  CostEstimate,
  Job,
  JobPayload,
  OutlineRevision,
  Project,
  ProjectSettings,
  Scene,
  ScriptRevision,
  Slide,
  SourceDocument,
  AvatarLayout,
} from "./entities.js";
import { Transition } from "./enums.js";

/** HTTP DTOs shared by apps/api and apps/web. Routes are documented in docs/API.md. */

export const CreateProjectRequest = z.object({
  name: z.string().min(1).max(200),
  settings: ProjectSettings.partial().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: ProjectSettings.deepPartial().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

/** Everything the editor needs to render a project in one round-trip. */
export const ProjectDetail = z.object({
  project: Project,
  sourceDocument: SourceDocument.optional(),
  slides: z.array(Slide),
  scenes: z.array(Scene),
  /** Latest revision per scene, keyed by sceneId. */
  scripts: z.record(Id, ScriptRevision),
  outline: OutlineRevision.optional(),
  assets: z.record(Id, Asset),
  activeJobs: z.array(Job),
  totalDurationSec: z.number().nonnegative(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const UpdateSceneRequest = z.object({
  muted: z.boolean().optional(),
  avatarLayout: AvatarLayout.nullable().optional(),
  transitionIn: Transition.nullable().optional(),
  tailPauseSec: z.number().min(0).max(10).optional(),
});
export type UpdateSceneRequest = z.infer<typeof UpdateSceneRequest>;

export const UpdateScriptRequest = z.object({
  script: z.string().max(5000),
  /** When omitted the API derives pronunciation/subtitle text from `script`. */
  pronunciationText: z.string().max(6000).optional(),
  subtitleText: z.string().max(5000).optional(),
});
export type UpdateScriptRequest = z.infer<typeof UpdateScriptRequest>;

export const ReorderSlidesRequest = z.object({
  /** Full ordered list of slide ids. */
  slideIds: z.array(Id).min(1),
});
export type ReorderSlidesRequest = z.infer<typeof ReorderSlidesRequest>;

export const EnqueueJobRequest = JobPayload;
export type EnqueueJobRequest = z.infer<typeof EnqueueJobRequest>;

export const EnqueueJobResponse = z.object({ job: Job, estimate: CostEstimate.optional() });
export type EnqueueJobResponse = z.infer<typeof EnqueueJobResponse>;

/** Server-sent event payloads on GET /projects/:id/events */
export const ProjectEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), job: Job }),
  z.object({ kind: z.literal("scene"), scene: Scene }),
  z.object({ kind: z.literal("script"), script: ScriptRevision }),
  z.object({ kind: z.literal("asset"), asset: Asset }),
  z.object({ kind: z.literal("slides"), slides: z.array(Slide), scenes: z.array(Scene) }),
  z.object({ kind: z.literal("outline"), outline: OutlineRevision }),
  z.object({ kind: z.literal("project"), project: Project }),
]);
export type ProjectEvent = z.infer<typeof ProjectEvent>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export const ProviderInfo = z.object({
  id: z.string(),
  kind: z.enum(["llm", "tts", "avatar"]),
  displayName: z.string(),
  requiresApiKey: z.boolean(),
  /** True when a platform key or a user key is configured. */
  configured: z.boolean(),
  /** Where the active key comes from: the server's .env ("platform") or the user's saved key ("user"). */
  keySource: z.enum(["platform", "user"]).optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

export const SetProviderKeyRequest = z.object({ apiKey: z.string().min(1).max(500) });
export type SetProviderKeyRequest = z.infer<typeof SetProviderKeyRequest>;
