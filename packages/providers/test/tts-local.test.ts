import { describe, expect, it } from "vitest";
import {
  LocalTtsProvider,
  localTtsHint,
  mapLocalVoices,
  splitLocalVoiceId,
} from "../src/tts/local.js";

const health = {
  ok: true,
  device: "cuda" as const,
  engines: {
    cosyvoice2: { installed: true, ready: false },
    gptsovits: { installed: false, ready: false },
    fishspeech: { installed: true, ready: false },
  },
  whisper: true,
};

describe("local tts provider", () => {
  it("lists one entry per voice and installed engine, engine encoded in the id", () => {
    const voices = mapLocalVoices(
      [
        {
          id: "v1",
          name: "阿光",
          durationSec: 8,
          transcript: "你好",
          language: "zh",
          previewUrl: "/voices/v1/sample.wav",
        },
      ],
      health,
      "http://t",
    );
    expect(voices.map((v) => v.id)).toEqual(["cosyvoice2/v1", "fishspeech/v1"]);
    expect(voices[0]!.name).toBe("我的聲音・阿光（CosyVoice 2）");
    expect(voices[0]!.previewUrl).toBe("http://t/voices/v1/sample.wav");
    expect(splitLocalVoiceId("gptsovits/abc")).toEqual({
      engine: "gptsovits",
      voiceId: "abc",
    });
    expect(splitLocalVoiceId("abc")).toEqual({
      engine: "cosyvoice2",
      voiceId: "abc",
    });
  });
  it("explains service state", () => {
    expect(localTtsHint(null)).toMatch(/pnpm dev:tts/);
    expect(
      localTtsHint({
        ...health,
        engines: { cosyvoice2: { installed: false, ready: false } },
      }),
    ).toMatch(/install\.ps1/);
    expect(localTtsHint(health)).toMatch(/未安裝：GPT-SoVITS/);
  });
  it("synthesizes via the service and returns wav bytes with timestamps", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/health")) return new Response(JSON.stringify(health));
      if (url.endsWith("/synthesize")) {
        expect(JSON.parse(init.body as string)).toMatchObject({
          text: "你好",
          voiceId: "v1",
          engine: "fishspeech",
          language: "zh-TW",
          speed: 1.1,
          timestamps: true,
        });
        return new Response(
          JSON.stringify({
            id: "s1",
            durationSec: 1.5,
            audioUrl: "/synth/s1.wav",
            sampleRate: 24000,
            timestamps: [{ text: "你", startSec: 0, endSec: 0.5 }],
          }),
        );
      }
      if (url.endsWith("/synth/s1.wav"))
        return new Response(new Uint8Array([82, 73, 70, 70]), {
          headers: { "content-type": "audio/wav" },
        });
      if (url.endsWith("/voices") && init.method === "POST") {
        const form = init.body as FormData;
        expect((form.get("file") as File).name).toBe("me.wav");
        expect(form.get("name")).toBe("me");
        return new Response(
          JSON.stringify({
            id: "v9",
            name: "me",
            durationSec: 6,
            transcript: "嗨",
            language: "zh",
            previewUrl: "/voices/v9/sample.wav",
          }),
          { status: 201 },
        );
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const p = new LocalTtsProvider({ baseUrl: "http://t" }, { fetchImpl });
    const r = await p.synthesize({
      text: "你好",
      voiceId: "fishspeech/v1",
      language: "zh-TW",
      speed: 1.1,
    });
    expect(r.data.mimeType).toBe("audio/wav");
    expect(r.data.audio.length).toBe(4);
    expect(r.data.timestamps![0]!.text).toBe("你");
    expect(r.usage[1]).toEqual({ unit: "audio_seconds", quantity: 1.5 });
    const v = await p.createVoice({
      data: new Uint8Array([1]),
      mimeType: "audio/wav",
      fileName: "me.wav",
      name: "me",
    });
    expect(v.id).toBe("cosyvoice2/v9");
    expect((await p.probe()).ok).toBe(true);
  });
});
