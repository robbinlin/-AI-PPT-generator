import { describe, expect, it } from "vitest";
import type { TtsRequest } from "@lvs/shared";
import {
  buildHeyGenTtsRequest,
  HEYGEN_TTS_FREE_MODEL,
  HeyGenTtsProvider,
  isFreeHeyGenVoice,
  mapHeyGenCatalogVoices,
  mapHeyGenModelVoices,
  mapHeyGenTimestamps,
  parseHeyGenVoiceId,
} from "../src/tts/heygen.js";

const req = (voiceId: string, extra: Partial<TtsRequest> = {}): TtsRequest => ({ text: "各位同學好", voiceId, language: "zh-TW", speed: 1.2, ...extra });

describe("heygen tts", () => {
  it("lists only ACTIVE clones, tagged by kind, before other private voices", () => {
    const v = mapHeyGenModelVoices({
      data: [
        { voice_id: "i1", mode: "instant", name: "林老師", status: "ACTIVE", preview_audio_url: "https://x/p.wav" },
        { voice_id: "p1", mode: "professional", name: "林老師 Pro", status: "ACTIVE" },
        { voice_id: "w", mode: "instant", name: "Pending", status: "PENDING" },
      ],
    });
    expect(v.map((x) => x.id)).toEqual(["instant:i1", "pro:p1"]);
    expect(v[0]).toMatchObject({ name: "我的聲音・林老師", previewUrl: "https://x/p.wav", tags: ["即時複製"], languages: ["zh-TW", "en", "mixed"] });
    const c = mapHeyGenCatalogVoices({ data: [{ voice_id: "c1", name: "林彥光", gender: "Male", default_engine: "starfish", available_engines: ["starfish"] }] });
    expect(c).toEqual([{ id: "catalog:c1", name: "我的聲音・林彥光", languages: ["zh-TW", "en", "mixed"], gender: "male", tags: ["Starfish"] }]);
  });

  it("routes each voice kind to its endpoint and model", () => {
    const instant = buildHeyGenTtsRequest(req("instant:i1"));
    expect(instant.path).toBe("/v3/models/audio/tts");
    expect(instant.body).toEqual({ model: HEYGEN_TTS_FREE_MODEL, voice_id: "i1", text: "各位同學好", language: "zh", expressiveness_boost: 0.5, with_timestamps: true });
    // Turbo models refuse professional clones.
    const pro = buildHeyGenTtsRequest(req("pro:p1", { speed: 2 }));
    expect(pro.body).toMatchObject({ model: "heygen-voice-1", voice_id: "p1", speed: 1.25 });
    const catalog = buildHeyGenTtsRequest(req("catalog:c1", { language: "mixed" }));
    expect(catalog).toEqual({ path: "/v3/voices/speech", body: { text: "各位同學好", voice_id: "c1", speed: 1.2 } });
    expect(parseHeyGenVoiceId("bare")).toEqual({ kind: "catalog", voiceId: "bare" });
  });

  it("knows which voices speak for free", () => {
    expect(isFreeHeyGenVoice("instant:i1")).toBe(true);
    expect(isFreeHeyGenVoice("instant:i1", "heygen-voice-1-turbo")).toBe(false);
    expect(isFreeHeyGenVoice("catalog:c1")).toBe(false);

  });

  it("turns character or word timings into per-character units", () => {
    const chars = mapHeyGenTimestamps({
      data: { original_characters: [{ text: "大", start_time: 0, end_time: 0.2 }, { text: "，", start_time: 0.2, end_time: 0.3 }, { text: "家", start_time: 0.3, end_time: 0.5 }] },
    });
    expect(chars).toEqual([{ text: "大", startSec: 0, endSec: 0.2 }, { text: "家", startSec: 0.3, endSec: 0.5 }]);
    const words = mapHeyGenTimestamps({ data: { word_timestamps: [{ word: "同學", start: 1, end: 1.4 }, { word: "OK", start: 1.4, end: 1.6 }] } });
    expect(words).toEqual([
      { text: "同", startSec: 1, endSec: 1.2 },
      { text: "學", startSec: 1.2, endSec: 1.4 },
      { text: "OK", startSec: 1.4, endSec: 1.6 },
    ]);
  });

  it("synthesizes, downloads the audio and keeps the key in the header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.startsWith("https://files.heygen.ai/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      return new Response(JSON.stringify({ data: { audio_url: "https://files.heygen.ai/a.mp3", duration: 1.234, word_timestamps: [{ word: "好", start: 0, end: 0.5 }], request_id: "r1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new HeyGenTtsProvider({ apiKey: "k-secret" }, { fetchImpl, retryBaseMs: 0 });
    const res = await p.synthesize(req("catalog:c1"));
    expect(calls[0]!.url).toBe("https://api.heygen.com/v3/voices/speech");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("k-secret");
    expect(calls[0]!.url).not.toContain("k-secret");
    expect(res.data).toMatchObject({ mimeType: "audio/mpeg", durationSec: 1.234, timestamps: [{ text: "好", startSec: 0, endSec: 0.5 }] });
    expect([...res.data.audio]).toEqual([1, 2, 3]);
    expect(res.providerRequestId).toBe("r1");
  });

  it("creates an instant clone: upload, clone once, wait for ACTIVE", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
      if (url.endsWith("/v3/assets")) return new Response(JSON.stringify({ data: { asset_id: "as1" } }), { status: 200 });
      if (url.endsWith("/v3/models/audio/voices")) return new Response(JSON.stringify({ data: { voice_id: "v9" } }), { status: 202 });
      polls += 1;
      const status = polls < 2 ? "PENDING" : "ACTIVE";
      return new Response(JSON.stringify({ data: { voice_id: "v9", mode: "instant", name: "林老師", status, created_at: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new HeyGenTtsProvider({ apiKey: "k" }, { fetchImpl, retryBaseMs: 0 }, 5, 0);
    const v = await p.createVoice({ data: new Uint8Array([1]), mimeType: "audio/mpeg", fileName: "a.mp3", name: "林老師" });
    expect(v).toMatchObject({ id: "instant:v9", name: "我的聲音・林老師" });
    const clone = calls.find((c) => c.url.endsWith("/v3/models/audio/voices"))!;
    expect(clone.headers["idempotency-key"]).toBe("lvs-as1");
    expect(JSON.parse(clone.body as string)).toEqual({ mode: "instant", name: "林老師", language: "zh", similarity: "max", audio: [{ type: "asset_id", asset_id: "as1" }] });
    expect(polls).toBe(2);
    await expect(p.createVoice({ data: new Uint8Array([1]), mimeType: "audio/mp4", fileName: "a.m4a", name: "x" })).rejects.toThrow(/MP3 or WAV/);
  });

  it("reports a failed clone with HeyGen's reason", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v3/assets")) return new Response(JSON.stringify({ data: { asset_id: "as1" } }), { status: 200 });
      if (url.endsWith("/v3/models/audio/voices")) return new Response(JSON.stringify({ data: { voice_id: "v9" } }), { status: 202 });
      return new Response(JSON.stringify({ data: { voice_id: "v9", mode: "instant", name: "x", status: "FAILED", failure_reason: "INSUFFICIENT_AUDIO", created_at: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new HeyGenTtsProvider({ apiKey: "k" }, { fetchImpl, retryBaseMs: 0 }, 5, 0);
    await expect(p.createVoice({ data: new Uint8Array([1]), mimeType: "audio/wav", fileName: "a.wav", name: "x" })).rejects.toThrow(/INSUFFICIENT_AUDIO/);
  });

  it("lists clones and catalog voices without duplicates, surviving one list failing", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/v3/models/audio/voices")) return new Response(JSON.stringify({ data: [{ voice_id: "same", mode: "instant", name: "A", status: "ACTIVE" }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ voice_id: "same", name: "A" }, { voice_id: "old", name: "B" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new HeyGenTtsProvider({ apiKey: "k" }, { fetchImpl, retryBaseMs: 0 });
    expect((await p.listVoices()).map((v) => v.id)).toEqual(["instant:same", "catalog:old"]);

    const failing = (async (url: string) =>
      url.includes("/v3/models/audio/voices")
        ? new Response("nope", { status: 403 })
        : new Response(JSON.stringify({ data: [{ voice_id: "old", name: "B" }] }), { status: 200 })) as unknown as typeof fetch;
    const q = new HeyGenTtsProvider({ apiKey: "k" }, { fetchImpl: failing, retryBaseMs: 0 });
    expect((await q.listVoices()).map((v) => v.id)).toEqual(["catalog:old"]);

    const twins = (async () => new Response(JSON.stringify({ data: [{ voice_id: "a", name: "林彥光" }, { voice_id: "b", name: "林彥光" }, { voice_id: "c", name: "其他" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = new HeyGenTtsProvider({ apiKey: "k" }, { fetchImpl: twins, retryBaseMs: 0 });
    expect((await r.listVoices()).map((v) => v.name)).toEqual(["我的聲音・林彥光 1", "我的聲音・林彥光 2", "我的聲音・其他"]);
  });
});
