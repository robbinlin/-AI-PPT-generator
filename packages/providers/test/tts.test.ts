import { describe, expect, it } from "vitest";
import type { TtsRequest } from "@lvs/shared";
import { buildElevenLabsRequest, ElevenLabsTtsProvider, mapElevenLabsResponse, mapElevenLabsVoices } from "../src/tts/elevenlabs.js";
import { buildGeminiTtsCall, mapGeminiTtsResponse } from "../src/tts/gemini.js";
import { MockTtsProvider } from "../src/tts/mock.js";
import { parseWavHeader } from "../src/wav.js";

const req: TtsRequest = { text: "今天介紹 VO2max。", voiceId: "v1", language: "zh-TW", speed: 1 };

describe("mock tts", () => {
  it("returns a silent WAV with matching duration and timestamps", async () => {
    const tts = new MockTtsProvider();
    const r = await tts.synthesize({ ...req, text: "一二三四五六七八九十一二" }); // 12 units -> 2 s
    expect(r.data.durationSec).toBe(2);
    expect(parseWavHeader(r.data.audio).durationSec).toBeCloseTo(2, 3);
    expect(r.data.timestamps).toHaveLength(12);
    expect(r.data.timestamps!.at(-1)!.endSec).toBeCloseTo(2, 2);
    expect(r.usage.find((u) => u.unit === "audio_seconds")?.quantity).toBe(2);
  });
  it("honours speed", async () => {
    const r = await new MockTtsProvider().synthesize({ ...req, text: "一二三四五六七八九十一二", speed: 2 });
    expect(r.data.durationSec).toBe(1);
  });
});

describe("gemini tts", () => {
  it("builds the call with voice and language steering", () => {
    const c = buildGeminiTtsCall({ ...req, speed: 0.8 });
    expect(c.model).toBe("gemini-2.5-flash-preview-tts");
    expect(c.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("v1");
    expect(c.contents[0]!.parts[0]!.text).toMatch(/slowly/);
    expect(c.contents[0]!.parts[0]!.text).toMatch(/今天介紹 VO2max。$/);
    expect(buildGeminiTtsCall({ ...req, language: "en" }).contents[0]!.parts[0]!.text).toBe(req.text);
  });
  it("wraps PCM into WAV and computes duration", () => {
    const pcm = Buffer.alloc(24_000 * 2 * 1.5); // 1.5 s
    const r = mapGeminiTtsResponse(
      { candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString("base64"), mimeType: "audio/L16;codec=pcm;rate=24000" } }] } }] },
      req,
    );
    expect(r.data.mimeType).toBe("audio/wav");
    expect(r.data.durationSec).toBe(1.5);
    expect(parseWavHeader(r.data.audio).sampleRate).toBe(24_000);
    expect(r.data.timestamps).toBeUndefined();
  });
  it("throws on empty audio", () => {
    expect(() => mapGeminiTtsResponse({ candidates: [] }, req)).toThrow(/no audio/);
  });
});

describe("elevenlabs tts", () => {
  it("builds the with-timestamps request", () => {
    const { url, body } = buildElevenLabsRequest({ ...req, speed: 1.5 });
    expect(url).toBe("/v1/text-to-speech/v1/with-timestamps?output_format=mp3_44100_128");
    expect(body.language_code).toBe("zh");
    expect(body.voice_settings.speed).toBe(1.2); // clamped
    expect(buildElevenLabsRequest({ ...req, language: "mixed" }).body.language_code).toBeUndefined();
  });
  it("maps alignment to timestamps and duration", () => {
    const text = "Hi 你";
    const characters = Array.from(text);
    const r = mapElevenLabsResponse(
      {
        audio_base64: Buffer.from("mp3").toString("base64"),
        alignment: {
          characters,
          character_start_times_seconds: [0, 0.1, 0.2, 0.3],
          character_end_times_seconds: [0.1, 0.2, 0.3, 0.45],
        },
      },
      req,
    );
    expect(r.data.mimeType).toBe("audio/mpeg");
    expect(r.data.durationSec).toBe(0.45);
    expect(r.data.timestamps!.map((t) => t.text)).toEqual(["Hi", "你"]);
    expect(r.usage[1]).toEqual({ unit: "audio_seconds", quantity: 0.45 });
  });
  it("maps voices", () => {
    const v = mapElevenLabsVoices({
      voices: [{ voice_id: "a", name: "A", labels: { gender: "female", accent: "taiwanese" }, verified_languages: [{ language: "zh" }], preview_url: "u" }],
    });
    expect(v[0]).toEqual({ id: "a", name: "A", languages: ["zh-TW", "mixed"], gender: "female", previewUrl: "u", tags: ["taiwanese"] });
  });
  it("sends the key in the xi-api-key header, never the URL", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ voices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new ElevenLabsTtsProvider({ apiKey: "k-secret" }, { fetchImpl });
    expect(await p.listVoices()).toEqual([]);
    expect(seen!.url).toBe("https://api.elevenlabs.io/v1/voices");
    expect(seen!.headers["xi-api-key"]).toBe("k-secret");
  });
});
