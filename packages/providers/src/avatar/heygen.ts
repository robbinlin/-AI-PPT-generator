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
 * HeyGen v3 API (v1/v2 are sunset on 2026-10-31). Every request/response mapping lives in
 * this file so a live test can fix field names in one place.
 *
 * Audio is uploaded to HeyGen as an asset (`POST /v3/assets`) and referenced by id, so the
 * API server never needs a publicly reachable URL; a plain `audioUrl` still works as fallback.
 */

// ---------------------------------------------------------------- mapping --

export const HEYGEN_ASPECT: Record<AspectRatio, "16:9" | "9:16" | "1:1"> = { "16:9": "16:9", "9:16": "9:16", "1:1": "1:1" };

/** Chroma-key green; the render worker keys it out when the provider has no alpha. */
export const HEYGEN_CHROMA_BACKGROUND = "#00FF00";

/** Overridable with HEYGEN_ENGINE (avatar_iv default; avatar_iii is the cheaper talking-photo engine). */
export type HeyGenEngine = "avatar_iv" | "avatar_iii" | "avatar_v";
const isHeyGenEngine = (e: string | undefined): e is HeyGenEngine => e === "avatar_iii" || e === "avatar_iv" || e === "avatar_v";
const envEngine = (): HeyGenEngine | undefined => {
  const e = process.env.HEYGEN_ENGINE;
  return isHeyGenEngine(e) ? e : undefined;
};

/** HEYGEN_REMOVE_BACKGROUND=0 disables matting (then the look's own scene stays behind the avatar). */
const envRemoveBackground = (): boolean => !/^(0|false|no)$/i.test(process.env.HEYGEN_REMOVE_BACKGROUND ?? "");

export interface HeyGenGenerateBody {
  type: "avatar";
  avatar_id: string;
  engine?: { type: HeyGenEngine };
  /** Matte the avatar onto `background`; verified to yield a clean chroma-green plate for the render worker. */
  remove_background?: boolean;
  audio_asset_id?: string;
  audio_url?: string;
  script?: string;
  voice_id?: string;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p";
  output_format: "mp4";
  background: { type: "color"; value: string };
  title?: string;
  callback_id?: string;
}

export function buildHeyGenGenerateBody(
  req: AvatarCreateRequest,
  audioAssetId?: string,
  engine = envEngine(),
  removeBackground = envRemoveBackground(),
): HeyGenGenerateBody {
  if (!audioAssetId && !req.audioUrl && !req.text) throw new Error("heygen: audio or text required");
  if (req.text && !audioAssetId && !req.audioUrl && !req.voiceId) throw new Error("heygen: voiceId required with text input");
  const source: Partial<HeyGenGenerateBody> = audioAssetId
    ? { audio_asset_id: audioAssetId }
    : req.audioUrl
      ? { audio_url: req.audioUrl }
      : { script: req.text!, voice_id: req.voiceId! };
  // The request's engine (chosen per character) wins over the HEYGEN_ENGINE default.
  const chosen = isHeyGenEngine(req.engine) ? req.engine : engine;
  return {
    type: "avatar",
    avatar_id: req.avatarId,
    ...(chosen ? { engine: { type: chosen } } : {}),
    ...(removeBackground ? { remove_background: true } : {}),
    ...source,
    aspect_ratio: HEYGEN_ASPECT[req.aspectRatio],
    resolution: "720p",
    output_format: "mp4",
    background: { type: "color", value: HEYGEN_CHROMA_BACKGROUND },
    ...(req.clientReference ? { callback_id: req.clientReference, title: `lvs ${req.clientReference}` } : {}),
  };
}

export interface HeyGenGenerateResponse {
  data?: { video_id?: string; status?: string } | null;
  error?: null | { code?: string; message?: string };
}

export function mapHeyGenGenerateResponse(res: HeyGenGenerateResponse): { taskId: string } {
  if (res.error) throw new Error(`heygen: ${res.error.message ?? res.error.code ?? "generate failed"}`);
  const id = res.data?.video_id;
  if (!id) throw new Error("heygen: response had no video_id");
  return { taskId: id };
}

export interface HeyGenStatusResponse {
  data?: {
    id?: string;
    status?: "pending" | "processing" | "completed" | "failed";
    video_url?: string | null;
    duration?: number | null;
    failure_code?: string | null;
    failure_message?: string | null;
  };
}

export function mapHeyGenStatus(taskId: string, res: HeyGenStatusResponse): AvatarTaskStatus {
  const d = res.data ?? {};
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
      return { taskId, status: "failed", error: d.failure_message ?? d.failure_code ?? "heygen: generation failed" };
    case "processing":
      return { taskId, status: "processing", progress: 0.5 };
    case "pending":
    default:
      return { taskId, status: "queued", progress: 0 };
  }
}

export interface HeyGenLooksResponse {
  data?: Array<{
    id: string;
    name: string;
    avatar_type?: string;
    preview_image_url?: string | null;
    gender?: string | null;
  }>;
  has_more?: boolean;
  next_token?: string | null;
}

export interface HeyGenAssetResponse {
  data?: { asset_id?: string; url?: string };
}

/** Private looks (the user's own likeness) are labelled and listed before the public library. */
export function mapHeyGenLooks(res: HeyGenLooksResponse, ownership: "private" | "public"): AvatarCharacter[] {
  return (res.data ?? []).map((l) => {
    const source = heyGenLookSource(l);
    return {
      id: l.id,
      name: ownership === "private" ? `我的人像・${l.name}` : l.name,
      kind: ownership === "private" ? "personal" : "stock",
      ...(l.preview_image_url ? { previewImageUrl: l.preview_image_url } : {}),
      ...(source ? { source } : {}),
    };
  });
}

/** Photo avatars ("talking photo") vs. video-trained ones, from avatar_type or the preview path. */
export function heyGenLookSource(l: { avatar_type?: string; preview_image_url?: string | null }): "photo" | "video" | undefined {
  const type = (l.avatar_type ?? "").toLowerCase();
  if (/photo/.test(type)) return "photo";
  if (type) return "video";
  if (/\/talking_photo\//.test(l.preview_image_url ?? "")) return "photo";
  if (/\/avatar\//.test(l.preview_image_url ?? "")) return "video";
  return undefined;
}

function isMattingRejection(err: unknown): boolean {
  const e = err as { status?: number; body?: string };
  return e?.status === 400 && /matting|remove_background|background/i.test(e.body ?? "");
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

  private headers(json = true): Record<string, string> {
    return { "x-api-key": this.apiKey, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) };
  }

  async listAvatars(): Promise<AvatarCharacter[]> {
    const out: AvatarCharacter[] = [];
    for (const ownership of ["private", "public"] as const) {
      let token: string | null | undefined;
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ ownership, limit: "50" });
        if (token) q.set("token", token);
        const res = await fetchJson<HeyGenLooksResponse>(`${this.baseUrl}/v3/avatars/looks?${q}`, { ...this.fetchOpts, headers: this.headers() });
        out.push(...mapHeyGenLooks(res, ownership));
        token = res.next_token;
        if (!res.has_more || !token) break;
      }
    }
    return out;
  }

  /** Uploads audio bytes as a HeyGen asset; returns the asset id to reference from a video. */
  async uploadAudio(data: Uint8Array, mimeType: string, fileName = "audio"): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([data], { type: mimeType }), fileName);
    const res = await fetchJson<HeyGenAssetResponse>(`${this.baseUrl}/v3/assets`, {
      ...this.fetchOpts,
      method: "POST",
      headers: this.headers(false),
      body: form,
      timeoutMs: this.fetchOpts.timeoutMs ?? 120_000,
    });
    const id = res.data?.asset_id;
    if (!id) throw new Error("heygen: asset upload returned no asset_id");
    return id;
  }

  async createTask(req: AvatarCreateRequest): Promise<{ taskId: string }> {
    const assetId = req.audio ? await this.uploadAudio(req.audio.data, req.audio.mimeType, req.audio.fileName) : undefined;
    const post = (body: HeyGenGenerateBody) =>
      fetchJson<HeyGenGenerateResponse>(`${this.baseUrl}/v3/videos`, {
        ...this.fetchOpts,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    const body = buildHeyGenGenerateBody(req, assetId);
    try {
      return mapHeyGenGenerateResponse(await post(body));
    } catch (err) {
      // Looks without matting support reject remove_background; keep their own backdrop instead.
      if (body.remove_background && isMattingRejection(err)) {
        const { remove_background: _rb, ...plain } = body;
        return mapHeyGenGenerateResponse(await post(plain));
      }
      throw err;
    }
  }

  async getTask(taskId: string): Promise<AvatarTaskStatus> {
    const res = await fetchJson<HeyGenStatusResponse>(`${this.baseUrl}/v3/videos/${encodeURIComponent(taskId)}`, {
      ...this.fetchOpts,
      headers: this.headers(),
    });
    return mapHeyGenStatus(taskId, res);
  }

  async cancelTask(taskId: string): Promise<void> {
    await fetchWithRetry(`${this.baseUrl}/v3/videos/${encodeURIComponent(taskId)}`, {
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
