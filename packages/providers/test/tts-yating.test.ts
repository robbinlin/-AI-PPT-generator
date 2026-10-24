import { describe, expect, it } from "vitest";
import { buildYatingBody, splitForYating, wavPcm, yatingSpeed, yatingWeight, YatingTtsProvider } from "../src/tts/yating.js";
import { parseWavHeader, pcmToWav } from "../src/wav.js";

/** A WAV like Yating's: a LIST chunk before `data`. */
function yatingWav(samples: number, rate = 22050): Uint8Array {
  const plain = pcmToWav(new Uint8Array(samples * 2).fill(1), { sampleRate: rate, channels: 1 });
  const list = new Uint8Array([...new TextEncoder().encode("LIST"), 4, 0, 0, 0, ...new TextEncoder().encode("INFO")]);
  const out = new Uint8Array(plain.byteLength + list.byteLength);
  out.set(plain.subarray(0, 36), 0);
  out.set(list, 36);
  out.set(plain.subarray(36), 36 + list.byteLength);
  return out;
}

describe("yating tts", () => {
  it("counts CJK and full-width characters double, like Yating's 600-character limit", () => {
    expect(yatingWeight("abc 1")).toBe(5);
    expect(yatingWeight("最大攝氧量")).toBe(10);
    expect(yatingWeight("VO₂max，")).toBe(8);
  });

  it("splits long narration after sentences, then clauses, within the limit", () => {
    const sentence = "這一頁說明最大攝氧量的定義與測量方式。";
    const text = sentence.repeat(30);
    const pieces = splitForYating(text, 200);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) {
      expect(yatingWeight(p)).toBeLessThanOrEqual(200);
      expect(p.endsWith("。")).toBe(true);
    }
    const noStops = "甲".repeat(250);
    expect(splitForYating(noStops, 200).map((p) => yatingWeight(p))).toEqual([200, 200, 100]);
    expect(splitForYating("  ")).toEqual([]);
  });

  it("maps our speaking rate to Yating's length factor and picks the sample rate per voice", () => {
    expect(yatingSpeed(1)).toBe(1);
    expect(yatingSpeed(1.25)).toBe(0.8);
    expect(yatingSpeed(0.5)).toBe(1.5);
    expect(yatingSpeed(3)).toBe(0.5);
    expect(buildYatingBody("你好", { voiceId: "zh_en_male_1", speed: 1 })).toEqual({
      input: { text: "你好", type: "text" },
      voice: { model: "zh_en_male_1", speed: 1, pitch: 1, energy: 1 },
      audioConfig: { encoding: "LINEAR16", sampleRate: "22K" },
    });
    expect(buildYatingBody("你好", { voiceId: "tai_female_1" }).audioConfig.sampleRate).toBe("16K");
  });

  it("finds the PCM after a LIST chunk", () => {
    const { pcm, fmt } = wavPcm(yatingWav(100));
    expect(pcm.byteLength).toBe(200);
    expect(fmt.sampleRate).toBe(22050);
  });

  it("synthesizes piece by piece with the key header and joins the audio in order", async () => {
    const seen: Array<{ url: string; key: string | null; text: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { input: { text: string } };
      seen.push({ url, key: new Headers(init.headers).get("key"), text: body.input.text });
      const b64 = Buffer.from(yatingWav(body.input.text.length * 100)).toString("base64");
      return new Response(JSON.stringify({ audioContent: b64 }), { status: 201 });
    }) as unknown as typeof fetch;
    const p = new YatingTtsProvider({ apiKey: "k-test" }, { fetchImpl, retryBaseMs: 0 });
    const text = "第一句話。".repeat(70); // 700 weight → two requests
    const res = await p.synthesize({ text, voiceId: "zh_en_female_1", language: "zh-TW", speed: 1 });
    expect(seen.length).toBe(2);
    expect(seen.every((s) => s.url === "https://tts.api.yating.tw/v2/speeches/short" && s.key === "k-test")).toBe(true);
    expect(seen.map((s) => s.text).join("")).toBe(text);
    const header = parseWavHeader(res.data.audio);
    expect(header.dataBytes).toBe(text.length * 100 * 2);
    expect(res.data.durationSec).toBeCloseTo((text.length * 100) / 22050, 2);
    expect(res.usage).toContainEqual({ unit: "chars", quantity: text.length });
    expect((await p.listVoices()).map((v) => v.id)).toContain("zh_en_male_1");
  });
});
