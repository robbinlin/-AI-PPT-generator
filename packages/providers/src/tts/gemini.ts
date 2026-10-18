import { GoogleGenAI } from "@google/genai";
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
import { pcmDurationSec, pcmToWav, sampleRateFromMime } from "../wav.js";

export const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";

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
 * Gemini TTS has no speed parameter; we steer pace with a natural-language
 * instruction prefix, which the model treats as direction rather than speech.
 */
export function buildGeminiTtsCall(req: TtsRequest, model = GEMINI_TTS_MODEL): GeminiTtsCall {
  const speed = req.speed ?? 1;
  const pace = speed < 0.9 ? "Speak slowly and clearly. " : speed > 1.15 ? "Speak briskly. " : "";
  const lang = req.language === "en" ? "" : "Read the following in Taiwanese Mandarin. ";
  const prefix = pace || lang ? `${pace}${lang}Read exactly this text:\n` : "";
  return {
    model,
    contents: [{ role: "user", parts: [{ text: prefix + req.text }] }],
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
  const pcm = fromBase64(inline.data);
  const fmt = { sampleRate: sampleRateFromMime(inline.mimeType), channels: 1 };
  const durationSec = Math.round(pcmDurationSec(pcm.byteLength, fmt) * 1000) / 1000;
  return {
    data: { audio: pcmToWav(pcm, fmt), mimeType: "audio/wav", sampleRate: fmt.sampleRate, durationSec },
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
    const res = await this.ai.models.generateContent(buildGeminiTtsCall(req, this.model));
    return mapGeminiTtsResponse(res as GeminiTtsLikeResponse, req);
  }
}

export const geminiTtsFactory: ProviderFactory<TtsProvider> = {
  id: "gemini",
  displayName: "Google Gemini TTS",
  requiresApiKey: true,
  create: (creds) => new GeminiTtsProvider(creds),
};
