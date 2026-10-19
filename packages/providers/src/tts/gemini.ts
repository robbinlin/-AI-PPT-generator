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
export const GEMINI_VOICES: Voice[] = [
  { id: "Kore", name: "Kore", languages: ["zh-TW", "en", "mixed"], gender: "female", tags: ["firm"] },
  { id: "Aoede", name: "Aoede", languages: ["zh-TW", "en", "mixed"], gender: "female", tags: ["breezy"] },
  { id: "Leda", name: "Leda", languages: ["zh-TW", "en", "mixed"], gender: "female", tags: ["youthful"] },
  { id: "Zephyr", name: "Zephyr", languages: ["zh-TW", "en", "mixed"], gender: "female", tags: ["bright"] },
  { id: "Puck", name: "Puck", languages: ["zh-TW", "en", "mixed"], gender: "male", tags: ["upbeat"] },
  { id: "Charon", name: "Charon", languages: ["zh-TW", "en", "mixed"], gender: "male", tags: ["informative"] },
  { id: "Fenrir", name: "Fenrir", languages: ["zh-TW", "en", "mixed"], gender: "male", tags: ["excitable"] },
  { id: "Orus", name: "Orus", languages: ["zh-TW", "en", "mixed"], gender: "male", tags: ["firm"] },
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
    return withGeminiRetry(models, async (model) => {
      const res = await this.ai.models.generateContent(buildGeminiTtsCall(req, model));
      return mapGeminiTtsResponse(res as GeminiTtsLikeResponse, req);
    });
  }
}

export const geminiTtsFactory: ProviderFactory<TtsProvider> = {
  id: "gemini",
  displayName: "Google Gemini TTS",
  requiresApiKey: true,
  create: (creds) => new GeminiTtsProvider(creds, envTtsModel()),
};
