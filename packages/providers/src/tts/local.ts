import type {
  Language,
  ProviderCredentials,
  ProviderFactory,
  ProviderResult,
  TtsCapabilities,
  TtsProvider,
  TtsRequest,
  TtsResult,
  Voice,
  WordTimestamp,
} from "@lvs/shared";
import { fetchJson, fetchWithRetry, type FetchOptions } from "../http.js";

/** Default address of the `workers/tts-local` service; override with LOCAL_TTS_URL. */
export const LOCAL_TTS_URL = "http://127.0.0.1:8766";
const envBaseUrl = () => process.env.LOCAL_TTS_URL || LOCAL_TTS_URL;

export type LocalTtsEngine = "cosyvoice2" | "gptsovits" | "fishspeech";
export const LOCAL_TTS_ENGINES: Array<{
  id: LocalTtsEngine;
  displayName: string;
}> = [
  { id: "cosyvoice2", displayName: "CosyVoice 2" },
  { id: "gptsovits", displayName: "GPT-SoVITS" },
  { id: "fishspeech", displayName: "Fish Speech" },
];

// ---------------------------------------------------------------- mapping --

export interface LocalTtsHealth {
  ok: boolean;
  device: "cuda" | "cpu";
  engines: Record<string, { installed: boolean; ready: boolean }>;
  whisper: boolean;
  version?: string;
}

export interface LocalVoice {
  id: string;
  name: string;
  durationSec: number;
  transcript: string;
  language: "zh" | "en" | "mixed";
  previewUrl: string;
}

export interface LocalSynthResponse {
  id: string;
  durationSec: number;
  audioUrl: string;
  sampleRate: number;
  timestamps: Array<{ text: string; startSec: number; endSec: number }> | null;
}

/** Voice ids are `<engine>/<voiceId>` so the engine is picked from the same dropdown as the voice. */
export function splitLocalVoiceId(id: string): {
  engine: LocalTtsEngine;
  voiceId: string;
} {
  const i = id.indexOf("/");
  const engine = (i === -1 ? "cosyvoice2" : id.slice(0, i)) as LocalTtsEngine;
  return { engine, voiceId: i === -1 ? id : id.slice(i + 1) };
}

export function mapLocalVoices(
  voices: LocalVoice[],
  health: LocalTtsHealth | null,
  baseUrl: string,
): Voice[] {
  const engines = LOCAL_TTS_ENGINES.filter(
    (e) => health?.engines[e.id]?.installed,
  );
  const langs: Language[] = ["zh-TW", "en", "mixed"];
  const out: Voice[] = [];
  for (const e of engines) {
    for (const v of voices) {
      out.push({
        id: `${e.id}/${v.id}`,
        name: `我的聲音・${v.name}（${e.displayName}）`,
        languages: langs,
        previewUrl: `${baseUrl}${v.previewUrl}`,
        tags: [e.displayName],
      });
    }
  }
  return out;
}

export function localTtsHint(
  health: LocalTtsHealth | null,
): string | undefined {
  if (!health)
    return "本機語音服務未啟動：請開一個 PowerShell 視窗執行 pnpm dev:tts";
  const installed = LOCAL_TTS_ENGINES.filter(
    (e) => health.engines[e.id]?.installed,
  );
  if (installed.length === 0)
    return "本機語音服務已啟動，但還沒有安裝任何語音引擎：請執行 workers\\tts-local\\install.ps1";
  const missing = LOCAL_TTS_ENGINES.filter(
    (e) => !health.engines[e.id]?.installed,
  ).map((e) => e.displayName);
  return missing.length
    ? `已安裝：${installed.map((e) => e.displayName).join("、")}；未安裝：${missing.join("、")}`
    : undefined;
}

// ---------------------------------------------------------------- provider --

/** Self-hosted TTS (`workers/tts-local`): the user's own cloned voice on their GPU, free. */
export class LocalTtsProvider implements TtsProvider {
  readonly id = "local";
  readonly capabilities: TtsCapabilities = {
    wordTimestamps: true,
    ssml: false,
    speedControl: true,
    maxChars: 2000,
    outputMimeType: "audio/wav",
    customVoices: true,
  };
  readonly baseUrl: string;

  constructor(
    creds: ProviderCredentials = {},
    private readonly fetchOpts: FetchOptions = {},
  ) {
    this.baseUrl = (creds.baseUrl ?? envBaseUrl()).replace(/\/$/, "");
  }

  private opts(extra: FetchOptions = {}): FetchOptions {
    return { maxRetries: 0, timeoutMs: 15_000, ...this.fetchOpts, ...extra };
  }

  async health(): Promise<LocalTtsHealth | null> {
    try {
      return await fetchJson<LocalTtsHealth>(
        `${this.baseUrl}/health`,
        this.opts({ timeoutMs: 3_000 }),
      );
    } catch {
      return null;
    }
  }

  async probe(): Promise<{ ok: boolean; hint?: string }> {
    const h = await this.health();
    const hint = localTtsHint(h);
    const ok =
      !!h?.ok && LOCAL_TTS_ENGINES.some((e) => h.engines[e.id]?.installed);
    return { ok, ...(hint ? { hint } : {}) };
  }

  async listVoices(): Promise<Voice[]> {
    const [voices, health] = await Promise.all([
      fetchJson<LocalVoice[]>(`${this.baseUrl}/voices`, this.opts()),
      this.health(),
    ]);
    return mapLocalVoices(voices, health, this.baseUrl);
  }

  async createVoice(input: {
    data: Uint8Array;
    mimeType: string;
    fileName: string;
    name: string;
    transcript?: string;
  }): Promise<Voice> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([input.data], { type: input.mimeType }),
      input.fileName,
    );
    form.append("name", input.name);
    if (input.transcript) form.append("transcript", input.transcript);
    // Whisper transcribes the clip when no transcript is given; give it time.
    const v = await fetchJson<LocalVoice>(
      `${this.baseUrl}/voices`,
      this.opts({ method: "POST", body: form, timeoutMs: 300_000 }),
    );
    const health = await this.health();
    const mapped = mapLocalVoices([v], health, this.baseUrl);
    return (
      mapped[0] ?? {
        id: `cosyvoice2/${v.id}`,
        name: `我的聲音・${v.name}`,
        languages: ["zh-TW", "en", "mixed"],
      }
    );
  }

  async renameVoice(id: string, name: string): Promise<void> {
    const { voiceId } = splitLocalVoiceId(id);
    await fetchJson<LocalVoice>(
      `${this.baseUrl}/voices/${encodeURIComponent(voiceId)}`,
      this.opts({ method: "PATCH", body: JSON.stringify({ name }), headers: { "content-type": "application/json" } }),
    );
  }

  async deleteVoice(id: string): Promise<void> {
    const { voiceId } = splitLocalVoiceId(id);
    await fetchWithRetry(
      `${this.baseUrl}/voices/${encodeURIComponent(voiceId)}`,
      this.opts({ method: "DELETE" }),
    );
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    const { engine, voiceId } = splitLocalVoiceId(req.voiceId);
    const res = await fetchJson<LocalSynthResponse>(
      `${this.baseUrl}/synthesize`,
      {
        ...this.opts({ timeoutMs: 20 * 60_000 }),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          voiceId,
          engine,
          language: req.language,
          speed: req.speed ?? 1,
          timestamps: true,
        }),
      },
    );
    const wav = await fetchWithRetry(
      `${this.baseUrl}${res.audioUrl}`,
      this.opts({ timeoutMs: 60_000 }),
    );
    const audio = new Uint8Array(await wav.arrayBuffer());
    const timestamps: WordTimestamp[] | undefined = res.timestamps?.length
      ? res.timestamps
      : undefined;
    return {
      data: {
        audio,
        mimeType: "audio/wav",
        sampleRate: res.sampleRate,
        durationSec: res.durationSec,
        ...(timestamps ? { timestamps } : {}),
      },
      usage: [
        { unit: "chars", quantity: req.text.length },
        { unit: "audio_seconds", quantity: res.durationSec },
      ],
    };
  }
}

export const localTtsFactory: ProviderFactory<TtsProvider> = {
  id: "local",
  displayName: "本機語音（免費，聲音複製）",
  requiresApiKey: false,
  create: (creds) => new LocalTtsProvider(creds),
};
