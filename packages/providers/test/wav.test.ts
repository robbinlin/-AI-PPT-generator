import { describe, expect, it } from "vitest";
import { parseWavHeader, pcmDurationSec, pcmToWav, sampleRateFromMime, silentWav } from "../src/wav.js";

describe("wav", () => {
  it("wraps PCM and reports duration", () => {
    const pcm = new Uint8Array(24_000 * 2); // 1 s of 16-bit mono at 24 kHz
    const wav = pcmToWav(pcm, { sampleRate: 24_000, channels: 1 });
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    const h = parseWavHeader(wav);
    expect(h.sampleRate).toBe(24_000);
    expect(h.channels).toBe(1);
    expect(h.bitsPerSample).toBe(16);
    expect(h.durationSec).toBeCloseTo(1, 5);
    expect(pcmDurationSec(pcm.byteLength, { sampleRate: 24_000, channels: 1 })).toBe(1);
  });
  it("silentWav produces the requested length", () => {
    const h = parseWavHeader(silentWav(2.5));
    expect(h.durationSec).toBeCloseTo(2.5, 3);
  });
  it("parses sample rate from a Gemini mime type", () => {
    expect(sampleRateFromMime("audio/L16;codec=pcm;rate=24000")).toBe(24_000);
    expect(sampleRateFromMime(undefined)).toBe(24_000);
    expect(sampleRateFromMime("audio/L16;rate=16000")).toBe(16_000);
  });
});
