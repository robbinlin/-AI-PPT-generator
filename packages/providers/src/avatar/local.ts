import type {
  AvatarCapabilities,
  AvatarCharacter,
  AvatarCreateRequest,
  AvatarProvider,
  AvatarTaskStatus,
  ProviderCredentials,
  ProviderFactory,
} from "@lvs/shared";
import {
  fetchJson,
  fetchWithRetry,
  HttpError,
  type FetchOptions,
} from "../http.js";

/** Default address of the `workers/avatar-local` service; override with LOCAL_AVATAR_URL. */
export const LOCAL_AVATAR_URL = "http://127.0.0.1:8765";
const envBaseUrl = () => process.env.LOCAL_AVATAR_URL || LOCAL_AVATAR_URL;

// ---------------------------------------------------------------- mapping --

export interface LocalHealth {
  ok: boolean;
  engine: "musetalk" | "passthrough";
  device: "cuda" | "cpu";
  modelsReady: boolean;
  version?: string;
}

export interface LocalCharacter {
  id: string;
  name: string;
  kind: "personal";
  previewImageUrl: string;
  ready: boolean;
  sourceKind: "image" | "video";
}

export interface LocalTask {
  taskId: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  progress: number;
  error: string | null;
  durationSec: number | null;
  resultUrl: string | null;
}

export function mapLocalCharacter(
  c: LocalCharacter,
  baseUrl: string,
): AvatarCharacter {
  return {
    id: c.id,
    name: c.name,
    kind: "personal",
    previewImageUrl: `${baseUrl}${c.previewImageUrl}`,
    source: c.sourceKind === "video" ? "video" : "photo",
  };
}

export function mapLocalTask(t: LocalTask, baseUrl: string): AvatarTaskStatus {
  switch (t.status) {
    case "succeeded":
      return {
        taskId: t.taskId,
        status: "succeeded",
        progress: 1,
        ...(t.resultUrl ? { resultUrl: `${baseUrl}${t.resultUrl}` } : {}),
        ...(typeof t.durationSec === "number"
          ? { durationSec: t.durationSec }
          : {}),
      };
    case "failed":
      return {
        taskId: t.taskId,
        status: "failed",
        error: t.error ?? "local avatar: generation failed",
      };
    case "processing":
      return {
        taskId: t.taskId,
        status: "processing",
        progress: t.progress ?? 0.5,
      };
    default:
      return { taskId: t.taskId, status: "queued", progress: 0 };
  }
}

/** Hint shown in the UI when the service is unreachable or running without the model. */
export function localHint(health: LocalHealth | null): string | undefined {
  if (!health)
    return "本機人像服務未啟動：請開一個 PowerShell 視窗執行 pnpm dev:avatar";
  if (health.engine === "passthrough")
    return "本機人像服務以測試模式執行（未安裝 MuseTalk 模型）：只會重播角色影片，不會對嘴型";
  return undefined;
}

// ---------------------------------------------------------------- provider --

/**
 * Talks to the self-hosted MuseTalk service (`workers/avatar-local`). Free, runs on the user's
 * GPU; characters are the user's own photos/videos uploaded through `createCharacter`.
 */
export class LocalAvatarProvider implements AvatarProvider {
  readonly id = "local";
  readonly capabilities: AvatarCapabilities = {
    acceptsAudio: true,
    acceptsText: false,
    transparentBackground: false,
    maxDurationSec: 600,
    aspectRatios: ["16:9", "9:16", "1:1"],
    billingUnit: "avatar_seconds",
    customCharacters: true,
  };
  readonly baseUrl: string;

  constructor(
    creds: ProviderCredentials = {},
    private readonly fetchOpts: FetchOptions = {},
  ) {
    this.baseUrl = (creds.baseUrl ?? envBaseUrl()).replace(/\/$/, "");
  }

  private opts(extra: FetchOptions = {}): FetchOptions {
    // The service is local: fail fast instead of retrying for a minute when it is not running.
    return { maxRetries: 0, timeoutMs: 15_000, ...this.fetchOpts, ...extra };
  }

  async health(): Promise<LocalHealth | null> {
    try {
      return await fetchJson<LocalHealth>(
        `${this.baseUrl}/health`,
        this.opts({ timeoutMs: 3_000 }),
      );
    } catch {
      return null;
    }
  }

  async probe(): Promise<{ ok: boolean; hint?: string }> {
    const h = await this.health();
    const hint = localHint(h);
    return { ok: !!h?.ok, ...(hint ? { hint } : {}) };
  }

  async listAvatars(): Promise<AvatarCharacter[]> {
    const list = await fetchJson<LocalCharacter[]>(
      `${this.baseUrl}/characters`,
      this.opts(),
    );
    return list.map((c) => mapLocalCharacter(c, this.baseUrl));
  }

  async createCharacter(input: { data: Uint8Array; mimeType: string; fileName: string; name: string }): Promise<AvatarCharacter> {
    const form = new FormData();
    // The worker picks the decoder from the file extension, so the original filename travels with the bytes.
    form.append("file", new Blob([input.data], { type: input.mimeType }), input.fileName);
    form.append("name", input.name);
    const c = await fetchJson<LocalCharacter>(
      `${this.baseUrl}/characters`,
      this.opts({ method: "POST", body: form, timeoutMs: 120_000 }),
    );
    return mapLocalCharacter(c, this.baseUrl);
  }

  async deleteCharacter(id: string): Promise<void> {
    await fetchWithRetry(
      `${this.baseUrl}/characters/${encodeURIComponent(id)}`,
      this.opts({ method: "DELETE" }),
    );
  }

  /** Raw preview image bytes, so the API can serve them without exposing the worker's address. */
  async characterPreview(
    id: string,
  ): Promise<{ data: Uint8Array; mimeType: string }> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/characters/${encodeURIComponent(id)}/preview.jpg`,
      this.opts(),
    );
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get("content-type") ?? "image/jpeg",
    };
  }

  async createTask(req: AvatarCreateRequest): Promise<{ taskId: string }> {
    let audio = req.audio;
    if (!audio && req.audioUrl) {
      const res = await fetchWithRetry(
        req.audioUrl,
        this.opts({ timeoutMs: 60_000 }),
      );
      audio = {
        data: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type") ?? "audio/mpeg",
      };
    }
    if (!audio)
      throw new Error(
        "local avatar: audio is required (text input is not supported)",
      );
    const form = new FormData();
    form.append(
      "audio",
      new Blob([audio.data], { type: audio.mimeType }),
      audio.fileName ?? "audio",
    );
    form.append("characterId", req.avatarId);
    const t = await fetchJson<LocalTask>(
      `${this.baseUrl}/tasks`,
      this.opts({ method: "POST", body: form, timeoutMs: 120_000 }),
    );
    return { taskId: t.taskId };
  }

  async getTask(taskId: string): Promise<AvatarTaskStatus> {
    const t = await fetchJson<LocalTask>(
      `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`,
      this.opts(),
    );
    return mapLocalTask(t, this.baseUrl);
  }

  async cancelTask(taskId: string): Promise<void> {
    await fetchWithRetry(
      `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`,
      this.opts({ method: "DELETE" }),
    ).catch((e) => {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    });
  }
}

export const localAvatarFactory: ProviderFactory<AvatarProvider> = {
  id: "local",
  // MuseTalk only animates the mouth; the name says so instead of naming the model.
  displayName: "本機人像（免費・只動嘴）",
  requiresApiKey: false,
  create: (creds) => new LocalAvatarProvider(creds),
};
