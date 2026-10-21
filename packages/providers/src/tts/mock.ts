import type {
  ProviderFactory,
  ProviderResult,
  TtsCapabilities,
  TtsProvider,
  TtsRequest,
  TtsResult,
  Voice,
} from "@lvs/shared";
import { silentWav } from "../wav.js";
import { evenTimestamps, timingUnits } from "./timing.js";

export const MOCK_VOICES: Voice[] = [
  {
    id: "mock-zh-f",
    name: "小芸 (mock)",
    languages: ["zh-TW", "mixed"],
    gender: "female",
  },
  {
    id: "mock-zh-m",
    name: "阿哲 (mock)",
    languages: ["zh-TW", "mixed"],
    gender: "male",
  },
  { id: "mock-en-f", name: "Ada (mock)", languages: ["en"], gender: "female" },
];

/** Offline TTS: silent WAV sized from the text, evenly spaced timestamps. */
export class MockTtsProvider implements TtsProvider {
  readonly id = "mock";
  readonly capabilities: TtsCapabilities = {
    wordTimestamps: true,
    ssml: false,
    speedControl: true,
    maxChars: 5000,
    outputMimeType: "audio/wav",
    customVoices: true,
  };
  readonly calls: TtsRequest[] = [];
  readonly voices: Voice[] = [...MOCK_VOICES];
  private seq = 0;

  async listVoices(): Promise<Voice[]> {
    return this.voices;
  }

  async createVoice(input: {
    data: Uint8Array;
    mimeType: string;
    fileName: string;
    name: string;
    transcript?: string;
  }): Promise<Voice> {
    if (!/^audio\//.test(input.mimeType))
      throw new Error("mock tts: reference must be an audio file");
    const v: Voice = {
      id: `mock-voice-${++this.seq}`,
      name: `我的聲音・${input.name}`,
      languages: ["zh-TW", "en", "mixed"],
    };
    this.voices.unshift(v);
    return v;
  }

  async deleteVoice(id: string): Promise<void> {
    const i = this.voices.findIndex((v) => v.id === id);
    if (i >= 0) this.voices.splice(i, 1);
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    this.calls.push(req);
    const units = timingUnits(req.text).length;
    const base = Math.max(1, units / 6);
    const durationSec = Math.round((base / (req.speed ?? 1)) * 1000) / 1000;
    const audio = silentWav(durationSec);
    return {
      data: {
        audio,
        mimeType: "audio/wav",
        sampleRate: 24_000,
        durationSec,
        timestamps: evenTimestamps(req.text, durationSec),
      },
      usage: [
        { unit: "chars", quantity: req.text.length },
        { unit: "audio_seconds", quantity: durationSec },
      ],
    };
  }
}

let sharedMockTts: MockTtsProvider | undefined;
export const mockTtsFactory: ProviderFactory<TtsProvider> = {
  id: "mock",
  displayName: "Mock TTS",
  requiresApiKey: false,
  // One instance so uploaded voices survive across API requests.
  create: () => (sharedMockTts ??= new MockTtsProvider()),
};
