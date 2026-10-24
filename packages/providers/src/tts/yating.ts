import type {
  ProviderCredentials,
  ProviderFactory,
  ProviderResult,
  TtsCapabilities,
  TtsProvider,
  TtsRequest,
  TtsResult,
  UsageDelta,
  Voice,
} from "@lvs/shared";
import { fetchJson, fromBase64, type FetchOptions } from "../http.js";
import { pcmDurationSec, pcmToWav, type PcmFormat } from "../wav.js";

/**
 * 雅婷 (Yating, Taiwan AI Labs) TTS, v2 short-speech API (developer.yating.tw):
 * POST /v2/speeches/short with header `key`; returns base64 LINEAR16 WAV. Taiwanese-accented
 * Mandarin/English voices plus Taiwanese (台語) voices. A request holds at most 600 "characters",
 * where a CJK character or full-width symbol counts 2, so longer narration is sent in pieces
 * (sentence by sentence) and the PCM is joined back into one WAV.
 */
export const YATING_BASE_URL = "https://tts.api.yating.tw";

/** Per-request limit, with headroom under the documented 600. */
export const YATING_MAX_WEIGHT = 560;

const BOTH: Voice["languages"] = ["zh-TW", "en", "mixed"];
export const YATING_VOICES: Voice[] = [
  { id: "zh_en_female_1", name: "雅婷（女聲）", languages: BOTH, gender: "female", tags: ["clear"] },
  { id: "zh_en_female_2", name: "意晴（女聲）", languages: BOTH, gender: "female", tags: ["warm"] },
  { id: "zh_en_male_1", name: "家豪（男聲）", languages: BOTH, gender: "male", tags: ["mature"] },
  { id: "zh_en_male_2", name: "志明（男聲）", languages: BOTH, gender: "male", tags: ["friendly"] },
  { id: "tai_female_1", name: "雅婷・台語（女聲）", languages: ["zh-TW"], gender: "female", tags: ["台語"] },
  { id: "tai_female_2", name: "意晴・台語（女聲）", languages: ["zh-TW"], gender: "female", tags: ["台語"] },
  { id: "tai_male_1", name: "家豪・台語（男聲）", languages: ["zh-TW"], gender: "male", tags: ["台語"] },
];

/** Yating's own count: CJK and full-width characters weigh 2, everything else 1. */
export function yatingWeight(text: string): number {
  let n = 0;
  for (const ch of text) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3ffff}]/u.test(ch) ? 2 : 1;
  return n;
}

/** Pieces of `text` no heavier than `max`, cut after sentence ends, then clauses, then anywhere. */
export function splitForYating(text: string, max = YATING_MAX_WEIGHT): string[] {
  const out: string[] = [];
  const push = (piece: string) => {
    const t = piece.trim();
    if (t) out.push(t);
  };
  const pack = (parts: string[], next: (part: string) => void) => {
    let cur = "";
    for (const p of parts) {
      if (yatingWeight(p) > max) {
        push(cur);
        cur = "";
        next(p);
      } else if (yatingWeight(cur + p) > max) {
        push(cur);
        cur = p;
      } else {
        cur += p;
      }
    }
    push(cur);
  };
  const hardCut = (part: string) => {
    let cur = "";
    for (const ch of part) {
      if (yatingWeight(cur + ch) > max) {
        push(cur);
        cur = "";
      }
      cur += ch;
    }
    push(cur);
  };
  const sentences = text.replace(/\r\n?/g, "\n").split(/(?<=[。！？!?；;\n]|\.\s)/u);
  pack(sentences, (long) => pack(long.split(/(?<=[，、,：:])/u), hardCut));
  return out;
}

/** Our speed is a rate (1.2 = faster); Yating's is a length factor (0.8 = shorter, i.e. faster). */
export function yatingSpeed(speed: number | undefined): number {
  const s = speed && speed > 0 ? speed : 1;
  return Math.round(Math.min(1.5, Math.max(0.5, 1 / s)) * 100) / 100;
}

export interface YatingRequestBody {
  input: { text: string; type: "text" };
  voice: { model: string; speed: number; pitch: number; energy: number };
  audioConfig: { encoding: "LINEAR16"; sampleRate: "16K" | "22K" };
}

export function buildYatingBody(text: string, req: Pick<TtsRequest, "voiceId" | "speed">): YatingRequestBody {
  return {
    input: { text, type: "text" },
    voice: { model: req.voiceId, speed: yatingSpeed(req.speed), pitch: 1, energy: 1 },
    // The Taiwanese voices only come at 16 kHz.
    audioConfig: { encoding: "LINEAR16", sampleRate: req.voiceId.startsWith("tai_") ? "16K" : "22K" },
  };
}

interface YatingResponse {
  audioContent?: string;
  audioFile?: { audioContent?: string };
}

/** The PCM payload and format of a WAV file (walks the chunks; Yating adds a LIST chunk). */
export function wavPcm(wav: Uint8Array): { pcm: Uint8Array; fmt: PcmFormat } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("yating: response is not a WAV file");
  let fmt: PcmFormat | undefined;
  let off = 12;
  while (off + 8 <= wav.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") fmt = { channels: v.getUint16(off + 10, true), sampleRate: v.getUint32(off + 12, true), bitsPerSample: v.getUint16(off + 22, true) };
    if (id === "data") {
      if (!fmt) throw new Error("yating: WAV has no fmt chunk");
      return { pcm: wav.subarray(off + 8, Math.min(wav.byteLength, off + 8 + size)), fmt };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("yating: WAV data chunk not found");
}

export class YatingTtsProvider implements TtsProvider {
  readonly id = "yating";
  readonly capabilities: TtsCapabilities = {
    wordTimestamps: false,
    ssml: false,
    speedControl: true,
    // Pieces are split here, so a whole page can be passed in.
    maxChars: 5000,
    outputMimeType: "audio/wav",
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    creds: ProviderCredentials,
    private readonly fetchOpts: FetchOptions = {},
  ) {
    if (!creds.apiKey) throw new Error("yating: apiKey required");
    this.apiKey = creds.apiKey;
    this.baseUrl = (creds.baseUrl ?? YATING_BASE_URL).replace(/\/$/, "");
  }

  async listVoices(): Promise<Voice[]> {
    return YATING_VOICES;
  }

  private async piece(text: string, req: TtsRequest): Promise<{ pcm: Uint8Array; fmt: PcmFormat }> {
    const res = await fetchJson<YatingResponse>(`${this.baseUrl}/v2/speeches/short`, {
      ...this.fetchOpts,
      method: "POST",
      headers: { key: this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildYatingBody(text, req)),
      timeoutMs: this.fetchOpts.timeoutMs ?? 120_000,
    });
    const b64 = res.audioContent ?? res.audioFile?.audioContent;
    if (!b64) throw new Error("yating: response had no audio");
    return wavPcm(fromBase64(b64));
  }

  async synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>> {
    const pieces = splitForYating(req.text);
    if (pieces.length === 0) throw new Error("yating: nothing to synthesize");
    // At most 3 requests at once per key (documented limit); order is kept.
    const results: Array<{ pcm: Uint8Array; fmt: PcmFormat }> = new Array(pieces.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= pieces.length) return;
        results[i] = await this.piece(pieces[i]!, req);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pieces.length) }, worker));
    const fmt = results[0]!.fmt;
    if (results.some((r) => r.fmt.sampleRate !== fmt.sampleRate || r.fmt.channels !== fmt.channels)) throw new Error("yating: pieces came back in different formats");
    const total = results.reduce((n, r) => n + r.pcm.byteLength, 0);
    const pcm = new Uint8Array(total);
    let at = 0;
    for (const r of results) {
      pcm.set(r.pcm, at);
      at += r.pcm.byteLength;
    }
    const durationSec = Math.round(pcmDurationSec(total, fmt) * 1000) / 1000;
    const usage: UsageDelta[] = [
      { unit: "chars", quantity: req.text.length },
      { unit: "audio_seconds", quantity: durationSec },
    ];
    return { data: { audio: pcmToWav(pcm, fmt), mimeType: "audio/wav", sampleRate: fmt.sampleRate, durationSec }, usage };
  }
}

export const yatingTtsFactory: ProviderFactory<TtsProvider> = {
  id: "yating",
  displayName: "雅婷（台灣口音）",
  requiresApiKey: true,
  create: (creds) => new YatingTtsProvider(creds),
};
