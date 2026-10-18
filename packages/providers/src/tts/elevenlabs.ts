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
} from "@lvs/shared";
import { fetchJson, fromBase64, type FetchOptions } from "../http.js";
import { groupCharacterAlignment } from "./timing.js";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";

// ----------------------------------------------------------------- mapping --

export interface ElevenLabsTtsBody {
  text: string;
  model_id: string;
  language_code?: string;
  voice_settings: { stability: number; similarity_boost: number; speed: number };
  /** Lexicon-style hints are not a public v1 field; we pre-substitute readings instead. */
}

export function buildElevenLabsRequest(req: TtsRequest, model = ELEVENLABS_MODEL): { url: string; body: ElevenLabsTtsBody } {
  const lang: Record<Language, string | undefined> = { "zh-TW": "zh", en: "en", mixed: undefined };
  const body: ElevenLabsTtsBody = {
    text: req.text,
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: clamp(req.speed ?? 1, 0.7, 1.2) },
  };
  const code = lang[req.language];
  if (code) body.language_code = code;
  return { url: `/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`, body };
}

export interface ElevenLabsTtsResponse {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
  normalized_alignment?: ElevenLabsTtsResponse["alignment"];
}

export function mapElevenLabsResponse(res: ElevenLabsTtsResponse, req: TtsRequest, requestId?: string): ProviderResult<TtsResult> {
  if (!res.audio_base64) throw new Error("elevenlabs returned no audio");
  const audio = fromBase64(res.audio_base64);
  const alignment = res.alignment ?? res.normalized_alignment ?? null;
  const timestamps = alignment
    ? groupCharacterAlignment({
        characters: alignment.characters,
        starts: alignment.character_start_times_seconds,
        ends: alignment.character_end_times_seconds,
      })
    : undefined;
  const lastEnd = alignment?.character_end_times_seconds.at(-1) ?? 0;
  const durationSec = Math.round(lastEnd * 1000) / 1000;
  return {
    data: { audio, mimeType: "audio/mpeg", sampleRate: 44_100, durationSec, ...(timestamps ? { timestamps } : {}) },
    usage: [
      { unit: "chars", quantity: req.text.length },
      { unit: "audio_seconds", quantity: durationSec },
    ],
    ...(requestId ? { providerRequestId: requestId } : {}),
  };
}

export interface ElevenLabsVoicesResponse {
  voices: Array<{
    voice_id: string;
    name: string;
    preview_url?: string;
    labels?: Record<string, string>;
    verified_languages?: Array<{ language: string }>;
  }>;
}

export function mapElevenLabsVoices(res: ElevenLabsVoicesResponse): Voice[] {
  return res.voices.map((v) => {
    const langs = new Set<Language>();
    for (const l of v.verified_languages ?? []) {
      if (l.language.startsWith("zh")) langs.add("zh-TW");
      if (l.language.startsWith("en")) langs.add("en");
    }
    if (langs.size === 0) {
      // multilingual models speak every voice in every language
      langs.add("zh-TW");
      langs.add("en");
    }
    langs.add("mixed");
    const g = v.labels?.gender;
    return {
      id: v.voice_id,
      name: v.name,
      languages: [...langs],
      ...(g === "female" || g === "male" ? { gender: g } : {}),
      ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
      tags: Object.entries(v.labels ?? {})
        .filter(([k]) => k !== "gender")
        .map(([, val]) => val),
    };
  });
}

// ---------------------------------------------------------------- provider --

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = "elevenlabs";
  readonly capabilities: TtsCapabilities = {
    wordTimestamps: true,
    ssml: false,
    speedControl: true,
    maxChars: 5000,
    outputMimeType: "audio/mpeg",
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    creds: ProviderCredentials,
    private readonly fetchOpts: FetchOptions = {},
  ) {
    if (!creds.apiKey) throw new Error("elevenlabs: apiKey required");
    this.apiKey = creds.apiKey;
    this.baseUrl = (creds.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return { "xi-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" };
  }

  async listVoices(): Promise<Voice[]> {
    const res = await fetchJson<ElevenLabsVoicesResponse>(`${this.baseUrl}/v1/voices`, { ...this.fetchOpts, headers: this.headers() });
    return mapElevenLabsVoices(res);
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    const { url, body } = buildElevenLabsRequest(req);
    const res = await fetchJson<ElevenLabsTtsResponse>(`${this.baseUrl}${url}`, {
      ...this.fetchOpts,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: this.fetchOpts.timeoutMs ?? 120_000,
    });
    return mapElevenLabsResponse(res, req);
  }
}

export const elevenLabsTtsFactory: ProviderFactory<TtsProvider> = {
  id: "elevenlabs",
  displayName: "ElevenLabs",
  requiresApiKey: true,
  create: (creds) => new ElevenLabsTtsProvider(creds),
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
