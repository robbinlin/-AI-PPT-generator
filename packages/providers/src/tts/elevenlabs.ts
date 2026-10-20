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
/** Overridable with ELEVENLABS_MODEL (e.g. eleven_v3, eleven_flash_v2_5). */
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const envModel = () => process.env.ELEVENLABS_MODEL || ELEVENLABS_MODEL;

/**
 * `language_code` enforcement is only honoured by the v2.5 turbo/flash models and v3; the
 * docs state it is "not supported for multilingual_v2 models", and the API rejects it there.
 */
export function supportsLanguageCode(model: string): boolean {
  return /_v2_5$|^eleven_v3|_v3$/.test(model);
}

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
  if (code && supportsLanguageCode(model)) body.language_code = code;
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
    category?: string;
    is_owner?: boolean | null;
    preview_url?: string | null;
    labels?: Record<string, string> | null;
    verified_languages?: Array<{ language: string }> | null;
  }>;
  has_more?: boolean;
  next_page_token?: string | null;
}

/** Category labels shown in the voice picker so users can tell their own voices from the stock ones. */
const CATEGORY_LABEL: Record<string, string> = {
  cloned: "我的聲音",
  professional: "我的聲音",
  generated: "我的聲音",
  premade: "內建",
};

export function mapElevenLabsVoices(res: ElevenLabsVoicesResponse): Voice[] {
  const own = (v: ElevenLabsVoicesResponse["voices"][number]) =>
    v.is_owner === true || v.category === "cloned" || v.category === "professional" || v.category === "generated";
  // The user's own voices come first, then the rest in the order the API returned them.
  const sorted = [...res.voices].sort((a, b) => Number(own(b)) - Number(own(a)));
  return sorted.map((v) => {
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
    const prefix = own(v) ? CATEGORY_LABEL.cloned : v.category ? CATEGORY_LABEL[v.category] : undefined;
    return {
      id: v.voice_id,
      name: prefix ? `${prefix}・${v.name}` : v.name,
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

  /**
   * v2 voices is paginated (default page size 10, which hid most of a user's library);
   * walk every page so cloned, generated and library-added voices all show up.
   */
  async listVoices(): Promise<Voice[]> {
    const all: ElevenLabsVoicesResponse["voices"] = [];
    let token: string | null | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ page_size: "100", include_total_count: "false" });
      if (token) q.set("next_page_token", token);
      const res = await fetchJson<ElevenLabsVoicesResponse>(`${this.baseUrl}/v2/voices?${q}`, { ...this.fetchOpts, headers: this.headers() });
      all.push(...res.voices);
      token = res.next_page_token;
      if (!res.has_more || !token) break;
    }
    return mapElevenLabsVoices({ voices: all });
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    const { url, body } = buildElevenLabsRequest(req, envModel());
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
