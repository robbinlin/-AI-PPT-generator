import { describe, expect, it } from "vitest";
import { avatarEngine, DEFAULT_PRICE_TABLE, estimateCost } from "../src/estimate.js";

describe("estimateCost", () => {
  it("tts by chars", () => {
    const e = estimateCost("synthesize_speech", { providerId: "elevenlabs", chars: 2000 });
    expect(e.lines).toEqual([{ providerId: "elevenlabs", unit: "chars", quantity: 2000, estimatedCost: 0.36 }]);
    expect(e.total).toBe(0.36);
    expect(e.currency).toBe("USD");
  });
  it("avatar by seconds and render", () => {
    expect(estimateCost("generate_avatar", { providerId: "heygen", seconds: 100 }).total).toBe(5);
    expect(estimateCost("render_video", { seconds: 600 }).total).toBe(1.2);
  });
  it("prices HeyGen video twins at the Avatar III rate and picks that engine only for them", () => {
    expect(estimateCost("generate_avatar", { providerId: "heygen", seconds: 60, engine: "avatar_iii" }).total).toBeCloseTo(1.0, 2);
    expect(estimateCost("generate_avatar", { providerId: "heygen", seconds: 60 }).total).toBe(3);
    expect(estimateCost("generate_avatar", { providerId: "heygen", seconds: 60, engine: "unknown" }).total).toBe(3);
    expect(avatarEngine({ providerId: "heygen", avatarSource: "video" })).toBe("avatar_iii");
    expect(avatarEngine({ providerId: "heygen", avatarSource: "photo" })).toBeUndefined();
    expect(avatarEngine({ providerId: "heygen" })).toBeUndefined();
    expect(avatarEngine({ providerId: "local", avatarSource: "video" })).toBeUndefined();
  });
  it("llm by prompt chars and calls", () => {
    const e = estimateCost("generate_script", { providerId: "anthropic", chars: 3000, calls: 10 });
    expect(e.lines[0]).toMatchObject({ unit: "tokens_in", quantity: 10_000 });
    expect(e.lines[1]).toMatchObject({ unit: "tokens_out", quantity: 8000 });
    expect(e.total).toBeCloseTo(10 * 0.004 + 8 * 0.02, 4);
  });
  it("unknown provider costs zero, custom table respected", () => {
    expect(estimateCost("synthesize_speech", { providerId: "nope", chars: 100 }).total).toBe(0);
    const t = { ...DEFAULT_PRICE_TABLE, tts: { x: { charsPer1k: 1 } } };
    expect(estimateCost("synthesize_speech", { providerId: "x", chars: 500 }, t).total).toBe(0.5);
  });
});
