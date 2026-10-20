import { z } from "zod";
import {
  ApiError,
  CostEstimate,
  EnqueueJobResponse,
  Job,
  Project,
  ProjectDetail,
  ProjectEvent,
  ProviderInfo,
  Scene,
  ScriptRevision,
  Slide,
  type CreateProjectRequest,
  type EnqueueJobRequest,
  type JobStatus,
  type ReorderSlidesRequest,
  type SetProviderKeyRequest,
  type UpdateProjectRequest,
  type UpdateSceneRequest,
  type UpdateScriptRequest,
} from "@lvs/shared";
import {
  ApiRequestError,
  AssetUrlResponse,
  AvatarCharacterSchema,
  HealthResponse,
  ProjectSummary,
  ReorderSlidesResponse,
  UploadSourceResponse,
  VoiceSchema,
  type ApiClient,
  type AssetUrlResponse as AssetUrl,
  type EstimateType,
  type ProjectEventListener,
  type ScriptExportFormat,
  type UploadOptions,
} from "./types";

export const DEFAULT_API_URL = "http://localhost:4000";

export function apiBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  return (fromEnv && fromEnv.trim()) || DEFAULT_API_URL;
}

const EVENT_KINDS: ReadonlyArray<ProjectEvent["kind"]> = ["job", "scene", "script", "asset", "slides", "outline", "project"];

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const enc = encodeURIComponent;

/** Typed `fetch` client for apps/api. Every JSON response is validated with the shared zod schema. */
export class HttpApiClient implements ApiClient {
  readonly mode = "http" as const;

  constructor(
    readonly baseUrl: string = apiBaseUrl(),
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  // ------------------------------------------------------------------ core

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async send(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit = { method, headers: { Accept: "application/json" } };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    // "Failed to fetch" means the API was unreachable (not running, or restarting). Idempotent
    // requests are retried a few times so a dev-server restart does not surface as a lost save.
    const retriable = method !== "POST";
    const delays = retriable ? [800, 1600, 3200] : [];
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(path), init);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        throw new Error(`無法連線到 API（${this.baseUrl}）。請確認後端伺服器正在執行。`);
      }
      if (!res.ok) throw await toApiError(res);
      return res;
    }
  }

  private async json<S extends z.ZodTypeAny>(schema: S, method: Method, path: string, body?: unknown): Promise<z.infer<S>> {
    const res = await this.send(method, path, body);
    const data: unknown = await res.json();
    return schema.parse(data);
  }

  // ---------------------------------------------------------------- health

  health(): Promise<HealthResponse> {
    return this.json(HealthResponse, "GET", "/health");
  }

  /** Health check with a timeout; used at boot to decide whether to fall back to the mock. */
  async ping(timeoutMs = 2500): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.send("GET", "/health", undefined, ctrl.signal);
      return HealthResponse.safeParse(await res.json()).success;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- providers

  listProviders() {
    return this.json(z.array(ProviderInfo), "GET", "/providers");
  }

  setProviderKey(providerId: string, req: SetProviderKeyRequest) {
    return this.json(ProviderInfo, "PUT", `/providers/${enc(providerId)}/key`, req);
  }

  deleteProviderKey(providerId: string) {
    return this.json(ProviderInfo, "DELETE", `/providers/${enc(providerId)}/key`);
  }

  listVoices(providerId: string) {
    return this.json(z.array(VoiceSchema), "GET", `/providers/${enc(providerId)}/voices`);
  }

  async previewVoice(providerId: string, voiceId: string, language: "zh-TW" | "en"): Promise<Blob> {
    const res = await this.send("POST", `/providers/${enc(providerId)}/voices/${enc(voiceId)}/preview?language=${language}`);
    return res.blob();
  }

  listAvatars(providerId: string) {
    return this.json(z.array(AvatarCharacterSchema), "GET", `/providers/${enc(providerId)}/avatars`);
  }

  // -------------------------------------------------------------- projects

  listProjects() {
    return this.json(z.array(ProjectSummary), "GET", "/projects");
  }

  createProject(req: CreateProjectRequest) {
    return this.json(Project, "POST", "/projects", req);
  }

  getProject(projectId: string) {
    return this.json(ProjectDetail, "GET", `/projects/${enc(projectId)}`);
  }

  updateProject(projectId: string, req: UpdateProjectRequest) {
    return this.json(Project, "PATCH", `/projects/${enc(projectId)}`, req);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.send("DELETE", `/projects/${enc(projectId)}`);
  }

  // ---------------------------------------------------------------- source

  uploadSource(projectId: string, file: File, options: UploadOptions = {}) {
    // XHR rather than fetch: fetch cannot report upload progress.
    return new Promise<UploadSourceResponse>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.url(`/projects/${enc(projectId)}/source`));
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) options.onProgress?.(ev.loaded / ev.total);
      };
      xhr.onerror = () => reject(new ApiRequestError("Network error", 0, "network_error"));
      xhr.onload = () => {
        let data: unknown;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = undefined;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(errorFromBody(xhr.status, xhr.statusText, data));
          return;
        }
        const parsed = UploadSourceResponse.safeParse(data);
        if (parsed.success) resolve(parsed.data);
        else reject(parsed.error);
      };
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    });
  }

  // ------------------------------------------------------- slides / scenes

  reorderSlides(projectId: string, req: ReorderSlidesRequest) {
    return this.json(ReorderSlidesResponse, "POST", `/projects/${enc(projectId)}/slides/reorder`, req);
  }

  setSlideHidden(projectId: string, slideId: string, hidden: boolean) {
    return this.json(Slide, "PATCH", `/projects/${enc(projectId)}/slides/${enc(slideId)}`, { hidden });
  }

  updateScene(projectId: string, sceneId: string, req: UpdateSceneRequest) {
    return this.json(Scene, "PATCH", `/projects/${enc(projectId)}/scenes/${enc(sceneId)}`, req);
  }

  updateScript(projectId: string, sceneId: string, req: UpdateScriptRequest) {
    return this.json(ScriptRevision, "PUT", `/projects/${enc(projectId)}/scenes/${enc(sceneId)}/script`, req);
  }

  listScriptRevisions(projectId: string, sceneId: string) {
    return this.json(z.array(ScriptRevision), "GET", `/projects/${enc(projectId)}/scenes/${enc(sceneId)}/scripts`);
  }

  // ------------------------------------------------------------------ jobs

  enqueueJob(projectId: string, req: EnqueueJobRequest) {
    return this.json(EnqueueJobResponse, "POST", `/projects/${enc(projectId)}/jobs`, req);
  }

  listJobs(projectId: string, status?: JobStatus) {
    const q = status ? `?status=${enc(status)}` : "";
    return this.json(z.array(Job), "GET", `/projects/${enc(projectId)}/jobs${q}`);
  }

  cancelJob(projectId: string, jobId: string) {
    return this.json(Job, "POST", `/projects/${enc(projectId)}/jobs/${enc(jobId)}/cancel`);
  }

  // ------------------------------------------------------ estimate / export

  getEstimate(projectId: string, type: EstimateType) {
    return this.json(CostEstimate, "GET", `/projects/${enc(projectId)}/estimate?type=${enc(type)}`);
  }

  async exportScript(projectId: string, format: ScriptExportFormat): Promise<Blob> {
    const res = await this.send("GET", `/projects/${enc(projectId)}/export/script?format=${enc(format)}`);
    return res.blob();
  }

  async getAssetUrl(projectId: string, assetId: string): Promise<AssetUrl> {
    const out = await this.json(AssetUrlResponse, "GET", `/projects/${enc(projectId)}/assets/${enc(assetId)}/url`);
    // Signed URLs may be relative to the API origin.
    return { ...out, url: out.url.startsWith("/") ? this.url(out.url) : out.url };
  }

  // ---------------------------------------------------------------- events

  subscribe(projectId: string, listener: ProjectEventListener): () => void {
    const source = new EventSource(this.url(`/projects/${enc(projectId)}/events`));
    const handle = (ev: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Servers may send `data` with or without the discriminator; fill it from the SSE event name.
      const withKind =
        data && typeof data === "object" && !("kind" in data) && ev.type !== "message"
          ? { kind: ev.type, ...(data as Record<string, unknown>) }
          : data;
      const parsed = ProjectEvent.safeParse(withKind);
      if (parsed.success) listener(parsed.data);
      else console.warn("Ignoring malformed project event", parsed.error.issues);
    };
    for (const kind of EVENT_KINDS) source.addEventListener(kind, handle);
    source.onmessage = handle;
    return () => source.close();
  }
}

async function toApiError(res: Response): Promise<ApiRequestError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return errorFromBody(res.status, res.statusText, body);
}

function errorFromBody(status: number, statusText: string, body: unknown): ApiRequestError {
  const parsed = ApiError.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiRequestError(message, status, code, details);
  }
  return new ApiRequestError(`${status} ${statusText}`.trim(), status, "http_error");
}
