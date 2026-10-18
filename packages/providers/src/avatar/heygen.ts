import type {
  AspectRatio,
  AvatarCapabilities,
  AvatarCharacter,
  AvatarCreateRequest,
  AvatarProvider,
  AvatarTaskStatus,
  ProviderCredentials,
  ProviderFactory,
} from "@lvs/shared";
import { fetchJson, fetchWithRetry, type FetchOptions } from "../http.js";

export const HEYGEN_BASE_URL = "https://api.heygen.com";

/**
 * Every HeyGen request/response mapping lives in this file so a live test can
 * fix field names in one place. Shapes follow the public v2 docs as of 2026.
 */

// ---------------------------------------------------------------- mapping --

export const HEYGEN_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 720, height: 720 },
};

/** Chroma-key green; the render worker keys it out when the provider has no alpha. */
export const HEYGEN_CHROMA_BACKGROUND = "#00FF00";

export interface HeyGenGenerateBody {
  title?: string;
  caption: false;
  dimension: { width: number; height: number };
  video_inputs: Array<{
    character: { type: "avatar"; avatar_id: string; avatar_style: "normal" | "circle" | "closeUp" };
    voice: { type: "audio"; audio_url: string } | { type: "text"; input_text: string; voice_id: string };
    background: { type: "color"; value: string };
  }>;
  callback_id?: string;
}

export function buildHeyGenGenerateBody(req: AvatarCreateRequest): HeyGenGenerateBody {
  if (!req.audioUrl && !req.text) throw new Error("heygen: audioUrl or text required");
  if (req.text && !req.voiceId) throw new Error("heygen: voiceId required with text input");
  const voice: HeyGenGenerateBody["video_inputs"][number]["voice"] = req.audioUrl
    ? { type: "audio", audio_url: req.audioUrl }
    : { type: "text", input_text: req.text!, voice_id: req.voiceId! };
  return {
    caption: false,
    dimension: HEYGEN_DIMENSIONS[req.aspectRatio],
    video_inputs: [
      {
        character: { type: "avatar", avatar_id: req.avatarId, avatar_style: "normal" },
        voice,
        background: { type: "color", value: HEYGEN_CHROMA_BACKGROUND },
      },
    ],
    ...(req.clientReference ? { callback_id: req.clientReference } : {}),
  };
}

export interface HeyGenGenerateResponse {
  error: null | { code?: string; message?: string };
  data?: { video_id?: string } | null;
}

export function mapHeyGenGenerateResponse(res: HeyGenGenerateResponse): { taskId: string } {
  if (res.error) throw new Error(`heygen: ${res.error.message ?? res.error.code ?? "generate failed"}`);
  const id = res.data?.video_id;
  if (!id) throw new Error("heygen: response had no video_id");
  return { taskId: id };
}

export interface HeyGenStatusResponse {
  code?: number;
  message?: string;
  data?: {
    id?: string;
    status?: "pending" | "waiting" | "processing" | "completed" | "failed";
    video_url?: string | null;
    duration?: number | null;
    error?: { message?: string; detail?: string } | string | null;
  };
}

export function mapHeyGenStatus(taskId: string, res: HeyGenStatusResponse): AvatarTaskStatus {
  const d = res.data ?? {};
  const err = typeof d.error === "string" ? d.error : d.error?.message ?? d.error?.detail;
  switch (d.status) {
    case "completed":
      return {
        taskId,
        status: "succeeded",
        progress: 1,
        ...(d.video_url ? { resultUrl: d.video_url } : {}),
        ...(typeof d.duration === "number" ? { durationSec: d.duration } : {}),
      };
    case "failed":
      return { taskId, status: "failed", error: err ?? "heygen: generation failed" };
    case "processing":
      return { taskId, status: "processing", progress: 0.5 };
    case "pending":
    case "waiting":
    default:
      return { taskId, status: "queued", progress: 0 };
  }
}

export interface HeyGenAvatarsResponse {
  data?: {
    avatars?: Array<{ avatar_id: string; avatar_name: string; preview_image_url?: string; premium?: boolean }>;
    talking_photos?: Array<{ talking_photo_id: string; talking_photo_name: string; preview_image_url?: string }>;
  };
}

export function mapHeyGenAvatars(res: HeyGenAvatarsResponse): AvatarCharacter[] {
  const out: AvatarCharacter[] = [];
  for (const a of res.data?.avatars ?? []) {
    out.push({ id: a.avatar_id, name: a.avatar_name, kind: "stock", ...(a.preview_image_url ? { previewImageUrl: a.preview_image_url } : {}) });
  }
  for (const p of res.data?.talking_photos ?? []) {
    out.push({
      id: p.talking_photo_id,
      name: p.talking_photo_name,
      kind: "personal",
      ...(p.preview_image_url ? { previewImageUrl: p.preview_image_url } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- provider --

export class HeyGenAvatarProvider implements AvatarProvider {
  readonly id = "heygen";
  readonly capabilities: AvatarCapabilities = {
    acceptsAudio: true,
    acceptsText: true,
    transparentBackground: false,
    maxDurationSec: 300,
    aspectRatios: ["16:9", "9:16", "1:1"],
    billingUnit: "avatar_seconds",
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    creds: ProviderCredentials,
    private readonly fetchOpts: FetchOptions = {},
  ) {
    if (!creds.apiKey) throw new Error("heygen: apiKey required");
    this.apiKey = creds.apiKey;
    this.baseUrl = (creds.baseUrl ?? HEYGEN_BASE_URL).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" };
  }

  async listAvatars(): Promise<AvatarCharacter[]> {
    const res = await fetchJson<HeyGenAvatarsResponse>(`${this.baseUrl}/v2/avatars`, { ...this.fetchOpts, headers: this.headers() });
    return mapHeyGenAvatars(res);
  }

  async createTask(req: AvatarCreateRequest): Promise<{ taskId: string }> {
    const res = await fetchJson<HeyGenGenerateResponse>(`${this.baseUrl}/v2/video/generate`, {
      ...this.fetchOpts,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildHeyGenGenerateBody(req)),
    });
    return mapHeyGenGenerateResponse(res);
  }

  async getTask(taskId: string): Promise<AvatarTaskStatus> {
    const res = await fetchJson<HeyGenStatusResponse>(`${this.baseUrl}/v1/video_status.get?video_id=${encodeURIComponent(taskId)}`, {
      ...this.fetchOpts,
      headers: this.headers(),
    });
    return mapHeyGenStatus(taskId, res);
  }

  async cancelTask(taskId: string): Promise<void> {
    await fetchWithRetry(`${this.baseUrl}/v1/video.delete?video_id=${encodeURIComponent(taskId)}`, {
      ...this.fetchOpts,
      method: "DELETE",
      headers: this.headers(),
      maxRetries: 0,
    }).catch(() => undefined); // best effort; a finished video cannot be cancelled
  }
}

export const heyGenAvatarFactory: ProviderFactory<AvatarProvider> = {
  id: "heygen",
  displayName: "HeyGen",
  requiresApiKey: true,
  create: (creds) => new HeyGenAvatarProvider(creds),
};
