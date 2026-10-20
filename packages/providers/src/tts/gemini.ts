import { GoogleGenAI } from "@google/genai";
import { parseModelList, withGeminiRetry } from "../gemini-retry.js";
import type {
  ProviderCredentials,
  ProviderFactory,
  ProviderResult,
  TtsCapabilities,
  TtsProvider,
  TtsRequest,
  TtsResult,
  Voice,
} from "@lvs/shared";
import { fromBase64 } from "../http.js";
import { pcmDurationSec, parseWavHeader, pcmToWav, sampleRateFromMime } from "../wav.js";

/** Overridable with GEMINI_TTS_MODEL. */
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
const envTtsModel = () => process.env.GEMINI_TTS_MODEL || GEMINI_TTS_MODEL;

/** Prebuilt Gemini voices (all multilingual). Names are the provider's voice ids. */
const L: Voice["languages"] = ["zh-TW", "en", "mixed"];
/**
 * Curated subset of Gemini's prebuilt voices with human-friendly labels. Gemini cannot change
 * a voice's age or accent, so labels describe the timbre you actually get; child voices and
 * regional accents need a provider with a voice library (ElevenLabs).
 */
export const GEMINI_VOICES: Voice[] = [
  { id: "Kore", name: "沉穩女聲（Kore）", languages: L, gender: "female", tags: ["firm", "adult"] },
  { id: "Leda", name: "年輕女聲（Leda）", languages: L, gender: "female", tags: ["youthful"] },
  { id: "Aoede", name: "輕快女聲（Aoede）", languages: L, gender: "female", tags: ["breezy"] },
  { id: "Zephyr", name: "明亮女聲（Zephyr）", languages: L, gender: "female", tags: ["bright"] },
  { id: "Sulafat", name: "溫暖女聲（Sulafat）", languages: L, gender: "female", tags: ["warm"] },
  { id: "Gacrux", name: "成熟女聲（Gacrux）", languages: L, gender: "female", tags: ["mature"] },
  { id: "Charon", name: "知性男聲（Charon）", languages: L, gender: "male", tags: ["informative"] },
  { id: "Orus", name: "穩重男聲（Orus）", languages: L, gender: "male", tags: ["firm", "adult"] },
  { id: "Puck", name: "活潑男聲（Puck）", languages: L, gender: "male", tags: ["upbeat"] },
  { id: "Achird", name: "親切男聲（Achird）", languages: L, gender: "male", tags: ["friendly"] },
  { id: "Iapetus", name: "清晰男聲（Iapetus）", languages: L, gender: "male", tags: ["clear"] },
  { id: "Fenrir", name: "有力男聲（Fenrir）", languages: L, gender: "male", tags: ["excitable"] },
];

export interface GeminiTtsCall {
  model: string;
  contents: { role: "user"; parts: { text: string }[] }[];
  config: {
    responseModalities: ["AUDIO"];
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
}

/**
 * Gemini TTS is given the text verbatim. Earlier models accepted a natural-language
 * instruction prefix ("Read the following in …"), but the 3.x TTS models read such
 * prefixes aloud, so pace/language steering is deliberately NOT done through the prompt.
 * Speed is adjusted downstream (speedControl: false) and language follows the text itself.
 */
export function buildGeminiTtsCall(req: TtsRequest, model = GEMINI_TTS_MODEL): GeminiTtsCall {
  return {
    model,
    contents: [{ role: "user", parts: [{ text: req.text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voiceId } } },
    },
  };
}

export interface GeminiTtsLikeResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
  responseId?: string;
}

export function mapGeminiTtsResponse(res: GeminiTtsLikeResponse, req: TtsRequest): ProviderResult<TtsResult> {
  const inline = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("gemini tts returned no audio");
  const bytes = fromBase64(inline.data);
  const mime = (inline.mimeType ?? "").toLowerCase();
  // Newer TTS models (gemini-3.x-flash-tts) return a complete WAV file; older ones return raw 16-bit PCM.
  const isWav = mime.startsWith("audio/wav") || (bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF");
  let audio: Uint8Array;
  let sampleRate: number;
  let durationSec: number;
  if (isWav) {
    const header = parseWavHeader(bytes);
    audio = bytes;
    sampleRate = header.sampleRate;
    durationSec = Math.round(header.durationSec * 1000) / 1000;
  } else {
    const fmt = { sampleRate: sampleRateFromMime(inline.mimeType), channels: 1 };
    audio = pcmToWav(bytes, fmt);
    sampleRate = fmt.sampleRate;
    durationSec = Math.round(pcmDurationSec(bytes.byteLength, fmt) * 1000) / 1000;
  }
  return {
    data: { audio, mimeType: "audio/wav", sampleRate, durationSec },
    usage: [
      { unit: "chars", quantity: req.text.length },
      { unit: "audio_seconds", quantity: durationSec },
    ],
    ...(res.responseId ? { providerRequestId: res.responseId } : {}),
  };
}

export class GeminiTtsProvider implements TtsProvider {
  readonly id = "gemini";
  readonly capabilities: TtsCapabilities = {
    wordTimestamps: false,
    ssml: false,
    speedControl: false,
    maxChars: 4000,
    outputMimeType: "audio/wav",
  };
  private readonly ai: GoogleGenAI;

  constructor(creds: ProviderCredentials, private readonly model = GEMINI_TTS_MODEL) {
    if (!creds.apiKey) throw new Error("gemini: apiKey required");
    this.ai = new GoogleGenAI({ apiKey: creds.apiKey, ...(creds.baseUrl ? { httpOptions: { baseUrl: creds.baseUrl } } : {}) });
  }

  async listVoices(): Promise<Voice[]> {
    return GEMINI_VOICES;
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    const models = [
      this.model,
      ...parseModelList(process.env.GEMINI_TTS_FALLBACK_MODELS, "gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview").filter((m) => m !== this.model),
    ];
    return withGeminiRetry(
      models,
      async (model) => {
        const res = await this.ai.models.generateContent(buildGeminiTtsCall(req, model));
        return mapGeminiTtsResponse(res as GeminiTtsLikeResponse, req);
      },
      `tts(${req.text.length} chars)`,
    );
  }
}

export const geminiTtsFactory: ProviderFactory<TtsProvider> = {
  id: "gemini",
  displayName: "Google Gemini TTS",
  requiresApiKey: true,
  create: (creds) => new GeminiTtsProvider(creds, envTtsModel()),
};
