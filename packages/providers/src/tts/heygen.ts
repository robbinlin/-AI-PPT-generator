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
import { HEYGEN_BASE_URL } from "../avatar/heygen.js";
import { Converter } from "opencc-js";
import { groupCharacterAlignment, timingUnits } from "./timing.js";

/**
 * HeyGen reads traditional Chinese badly (新生兒 → 新生以, 連續 → 連數, 兩組 → 兩種, measured on the
 * free model) and simplified text cleanly, so Chinese is sent simplified. Character variants only
 * ("tw" → "cn", no vocabulary swaps), so the text keeps its length and the timings map back.
 */
const toSimplified = Converter({ from: "tw", to: "cn" });

/**
 * HeyGen speech with the same key as the HeyGen presenter. Two kinds of voice, two endpoints:
 *
 * - HeyGen Voice clones (instant / professional, `GET /v3/models/audio/voices`) speak through
 *   `POST /v3/models/audio/tts`. Instant clones use `heygen-voice-1-turbo-free`, which HeyGen
 *   offers free until 2026-11-30 (HEYGEN_TTS_MODEL overrides; a free request is never switched
 *   to a paid model). Professional clones need `heygen-voice-1` (paid).
 * - Catalog voices (`GET /v3/voices?type=private`: older clones and designed voices) speak through
 *   `POST /v3/voices/speech` (paid).
 *
 * The voice id carries which one it is ("instant:<id>", "pro:<id>", "catalog:<id>"), so a project
 * keeps working without looking the voice up again.
 */

export const HEYGEN_TTS_FREE_MODEL = "heygen-voice-1-turbo-free";
const envModel = () => process.env.HEYGEN_TTS_MODEL || HEYGEN_TTS_FREE_MODEL;

export type HeyGenVoiceKind = "instant" | "pro" | "catalog";

export function parseHeyGenVoiceId(id: string): { kind: HeyGenVoiceKind; voiceId: string } {
  const m = /^(instant|pro|catalog):(.+)$/.exec(id);
  return m ? { kind: m[1] as HeyGenVoiceKind, voiceId: m[2]! } : { kind: "catalog", voiceId: id };
}

/** True when speaking with this voice costs nothing (instant clones on the free model). */
export function isFreeHeyGenVoice(id: string, model = envModel()): boolean {
  return parseHeyGenVoiceId(id).kind === "instant" && model === HEYGEN_TTS_FREE_MODEL;
}

const LANG: Record<Language, string | undefined> = { "zh-TW": "zh", en: "en", mixed: undefined };

// ----------------------------------------------------------------- mapping --

export interface HeyGenModelVoicesResponse {
  data?: Array<{
    voice_id: string;
    mode: "instant" | "professional";
    name: string;
    language?: string | null;
    status: "PENDING" | "ACTIVE" | "FAILED";
    preview_audio_url?: string | null;
  }>;
  has_more?: boolean;
  next_token?: string | null;
}

export interface HeyGenCatalogVoicesResponse {
  data?: Array<{
    voice_id: string;
    name: string;
    language?: string;
    gender?: string;
    preview_audio_url?: string | null;
    type?: "public" | "private";
    available_engines?: string[];
    default_engine?: string | null;
  }>;
  has_more?: boolean;
  next_token?: string | null;
}

const ALL_LANGS: Language[] = ["zh-TW", "en", "mixed"];
const ENGINE_LABEL: Record<string, string> = { starfish: "Starfish", orca: "HeyGen Voice", elevenlabs: "ElevenLabs", elevenlabs_v3: "ElevenLabs" };

/** Only ACTIVE clones can speak; pending or failed ones would just fail every page. */
export function mapHeyGenModelVoices(res: HeyGenModelVoicesResponse): Voice[] {
  return (res.data ?? [])
    .filter((v) => v.status === "ACTIVE")
    .map((v) => ({
      id: `${v.mode === "professional" ? "pro" : "instant"}:${v.voice_id}`,
      name: `我的聲音・${v.name}`,
      // HeyGen Voice speaks every supported language with the cloned timbre.
      languages: ALL_LANGS,
      ...(v.preview_audio_url ? { previewUrl: v.preview_audio_url } : {}),
      tags: [v.mode === "professional" ? "專業複製" : "即時複製"],
    }));
}

export function mapHeyGenCatalogVoices(res: HeyGenCatalogVoicesResponse): Voice[] {
  return (res.data ?? [])
    .filter((v) => (v.available_engines?.length ?? 1) > 0)
    .map((v) => {
      const g = v.gender?.toLowerCase();
      return {
        id: `catalog:${v.voice_id}`,
        name: `我的聲音・${v.name}`,
        languages: ALL_LANGS,
        ...(g === "female" || g === "male" ? { gender: g } : {}),
        ...(v.preview_audio_url ? { previewUrl: v.preview_audio_url } : {}),
        // Two clones often share the owner's name; the engine tells them apart.
        tags: v.default_engine ? [ENGINE_LABEL[v.default_engine] ?? v.default_engine] : [],
      };
    });
}

export interface HeyGenModelTtsBody {
  model: string;
  voice_id: string;
  text: string;
  language?: string;
  expressiveness_boost?: number;
  speed?: number;
  with_timestamps: boolean;
}

export interface HeyGenCatalogSpeechBody {
  text: string;
  voice_id: string;
  speed: number;
  language?: string;
}

export function buildHeyGenTtsRequest(
  req: TtsRequest,
  model = envModel(),
): { path: string; body: HeyGenModelTtsBody | HeyGenCatalogSpeechBody } {
  const { kind, voiceId } = parseHeyGenVoiceId(req.voiceId);
  const language = LANG[req.language];
  const text = req.language === "en" ? req.text : toSimplified(req.text);
  if (kind === "catalog") {
    return {
      path: "/v3/voices/speech",
      body: { text, voice_id: voiceId, speed: clamp(req.speed ?? 1, 0.5, 2), ...(language ? { language } : {}) },
    };
  }
  return {
    path: "/v3/models/audio/tts",
    body: {
      // Turbo models refuse professional clones; those need the full model (paid).
      model: kind === "pro" ? "heygen-voice-1" : model,
      voice_id: voiceId,
      text,
      ...(language ? { language } : {}),
      // HeyGen Studio's setting for the closest match to the speaker (the API default 1.0 drifts).
      ...(kind === "instant" ? { expressiveness_boost: 0.5 } : { speed: clamp(req.speed ?? 1, 0.75, 1.25) }),
      with_timestamps: true,
    },
  };
}

export interface HeyGenSpeechResponse {
  data?: {
    audio_url?: string;
    duration?: number;
    original_characters?: Array<{ text: string; start_time: number; end_time: number }> | null;
    word_timestamps?: Array<{ word: string; start: number; end: number }> | null;
    request_id?: string | null;
  };
}

/** Character timings (model voices) or word timings (catalog voices) → the app's timing units. */
export function mapHeyGenTimestamps(res: HeyGenSpeechResponse): WordTimestamp[] | undefined {
  const chars = res.data?.original_characters;
  if (chars?.length) {
    return groupCharacterAlignment({
      characters: chars.map((c) => c.text),
      starts: chars.map((c) => c.start_time),
      ends: chars.map((c) => c.end_time),
    });
  }
  const words = res.data?.word_timestamps;
  if (words?.length) {
    // A catalog "word" can hold several CJK characters; spread its time over them evenly.
    const out: WordTimestamp[] = [];
    for (const w of words) {
      const units = timingUnits(w.word);
      const step = units.length ? (w.end - w.start) / units.length : 0;
      units.forEach((u, i) => out.push({ text: u.text, startSec: w.start + i * step, endSec: w.start + (i + 1) * step }));
    }
    return out;
  }
  return undefined;
}

/** Timings come back in the simplified text that was spoken; give them the caller's characters again. */
export function restoreOriginalText(ts: WordTimestamp[] | undefined, original: string): WordTimestamp[] | undefined {
  if (!ts) return ts;
  const units = timingUnits(original);
  return units.length === ts.length ? ts.map((t, i) => ({ ...t, text: units[i]!.text })) : ts;
}

/** HeyGen names every clone after its owner (and older ones carry no engine), so same names get 1, 2, … */
export function numberDuplicateNames(voices: Voice[]): Voice[] {
  const total = new Map<string, number>();
  for (const v of voices) total.set(v.name, (total.get(v.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return voices.map((v) => {
    if ((total.get(v.name) ?? 0) < 2) return v;
    const n = (seen.get(v.name) ?? 0) + 1;
    seen.set(v.name, n);
    return { ...v, name: `${v.name} ${n}` };
  });
}

function mimeOf(url: string, header: string | null): string {
  if (header && /^audio\//.test(header)) return header.split(";")[0]!.trim() === "audio/mp3" ? "audio/mpeg" : header.split(";")[0]!.trim();
  return /\.mp3(\?|$)/i.test(url) ? "audio/mpeg" : "audio/wav";
}

// ---------------------------------------------------------------- provider --

export class HeyGenTtsProvider implements TtsProvider {
  readonly id = "heygen";
  readonly capabilities: TtsCapabilities = {
    wordTimestamps: true,
    ssml: false,
    // Instant clones ignore speed; catalog and professional voices take it.
    speedControl: true,
    maxChars: 5000,
    outputMimeType: "audio/wav",
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    creds: ProviderCredentials,
    private readonly fetchOpts: FetchOptions = {},
    /** Waiting for a new clone to become ACTIVE: polls × interval (about 3 minutes by default). */
    private readonly clonePolls = 60,
    private readonly clonePollMs = 3000,
  ) {
    if (!creds.apiKey) throw new Error("heygen: apiKey required");
    this.apiKey = creds.apiKey;
    this.baseUrl = (creds.baseUrl ?? HEYGEN_BASE_URL).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" };
  }

  private async pages<R extends { has_more?: boolean; next_token?: string | null }>(path: string, params: Record<string, string>): Promise<R[]> {
    const out: R[] = [];
    let token: string | null | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ ...params, limit: "100" });
      if (token) q.set("token", token);
      const res = await fetchJson<R>(`${this.baseUrl}${path}?${q}`, { ...this.fetchOpts, headers: this.headers() });
      out.push(res);
      token = res.next_token;
      if (!res.has_more || !token) break;
    }
    return out;
  }

  /** The user's own voices only: HeyGen Voice clones first, then other private catalog voices. */
  async listVoices(): Promise<Voice[]> {
    const [model, catalog] = await Promise.allSettled([
      this.pages<HeyGenModelVoicesResponse>("/v3/models/audio/voices", { type: "private" }),
      this.pages<HeyGenCatalogVoicesResponse>("/v3/voices", { type: "private" }),
    ]);
    // One list failing (plan, outage) still shows the other; both failing is an error.
    if (model.status === "rejected" && catalog.status === "rejected") throw model.reason;
    const clones = model.status === "fulfilled" ? model.value.flatMap(mapHeyGenModelVoices) : [];
    const seen = new Set(clones.map((v) => parseHeyGenVoiceId(v.id).voiceId));
    const others = (catalog.status === "fulfilled" ? catalog.value.flatMap(mapHeyGenCatalogVoices) : []).filter(
      (v) => !seen.has(parseHeyGenVoiceId(v.id).voiceId),
    );
    return numberDuplicateNames([...clones, ...others]);
  }

  /**
   * Instant voice clone from one recording (HeyGen uses its first 3 minutes; MP3 or WAV). Creating
   * one is not billed; it is ACTIVE within seconds and then speaks on the free model.
   */
  async createVoice(input: { data: Uint8Array; mimeType: string; fileName: string; name: string }): Promise<Voice> {
    if (!/^audio\/(mpeg|mp3|wav|x-wav|wave)$/.test(input.mimeType)) throw new Error("heygen: a voice clone needs an MP3 or WAV recording");
    const form = new FormData();
    form.append("file", new Blob([input.data], { type: input.mimeType }), input.fileName);
    const asset = await fetchJson<{ data?: { asset_id?: string } }>(`${this.baseUrl}/v3/assets`, {
      ...this.fetchOpts,
      method: "POST",
      headers: { "x-api-key": this.apiKey, accept: "application/json" },
      body: form,
      timeoutMs: this.fetchOpts.timeoutMs ?? 120_000,
    });
    const assetId = asset.data?.asset_id;
    if (!assetId) throw new Error("heygen: recording upload returned no asset_id");
    const created = await fetchJson<{ data?: { voice_id?: string } }>(`${this.baseUrl}/v3/models/audio/voices`, {
      ...this.fetchOpts,
      method: "POST",
      // A retried request must not make a second voice.
      headers: { ...this.headers(), "idempotency-key": `lvs-${assetId}` },
      body: JSON.stringify({
        mode: "instant",
        name: input.name.slice(0, 64),
        language: "zh",
        // HeyGen Studio's setting for the closest match to the speaker.
        similarity: "max",
        audio: [{ type: "asset_id", asset_id: assetId }],
      }),
    });
    const voiceId = created.data?.voice_id;
    if (!voiceId) throw new Error("heygen: voice clone returned no voice_id");
    for (let i = 0; i < this.clonePolls; i++) {
      const res = await fetchJson<{ data?: NonNullable<HeyGenModelVoicesResponse["data"]>[number] & { failure_reason?: string | null } }>(
        `${this.baseUrl}/v3/models/audio/voices/${encodeURIComponent(voiceId)}`,
        { ...this.fetchOpts, headers: this.headers() },
      );
      const v = res.data;
      if (v?.status === "ACTIVE") return mapHeyGenModelVoices({ data: [v] })[0]!;
      if (v?.status === "FAILED") throw new Error(`heygen: voice clone failed (${v.failure_reason ?? "unknown reason"})`);
      await new Promise((r) => setTimeout(r, this.clonePollMs));
    }
    throw new Error(`heygen: voice ${voiceId} was still being prepared; it appears in the list once HeyGen finishes`);
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    const { path, body } = buildHeyGenTtsRequest(req);
    const res = await fetchJson<HeyGenSpeechResponse>(`${this.baseUrl}${path}`, {
      ...this.fetchOpts,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: this.fetchOpts.timeoutMs ?? 180_000,
    });
    const url = res.data?.audio_url;
    if (!url) throw new Error("heygen: speech response had no audio_url");
    const file = await fetchWithRetry(url, { ...this.fetchOpts, timeoutMs: this.fetchOpts.timeoutMs ?? 120_000 });
    const audio = new Uint8Array(await file.arrayBuffer());
    const timestamps = restoreOriginalText(mapHeyGenTimestamps(res), req.text);
    const durationSec = Math.round((res.data?.duration ?? timestamps?.at(-1)?.endSec ?? 0) * 1000) / 1000;
    return {
      data: { audio, mimeType: mimeOf(url, file.headers.get("content-type")), durationSec, ...(timestamps?.length ? { timestamps } : {}) },
      usage: [
        { unit: "chars", quantity: req.text.length },
        { unit: "audio_seconds", quantity: durationSec },
      ],
      ...(res.data?.request_id ? { providerRequestId: res.data.request_id } : {}),
    };
  }
}

export const heyGenTtsFactory: ProviderFactory<TtsProvider> = {
  id: "heygen",
  displayName: "HeyGen",
  requiresApiKey: true,
  create: (creds) => new HeyGenTtsProvider(creds),
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
