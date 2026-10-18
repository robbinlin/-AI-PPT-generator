import { describe, expect, it } from "vitest";
import { evenTimestamps, groupCharacterAlignment, timingUnits } from "../src/tts/timing.js";

describe("timingUnits", () => {
  it("splits CJK per character and Latin per word", () => {
    const u = timingUnits("今天介紹 VO2max 的概念。Hello world!").map((x) => x.text);
    expect(u).toEqual(["今", "天", "介", "紹", "VO2max", "的", "概", "念", "Hello", "world"]);
  });
  it("ignores punctuation-only text", () => {
    expect(timingUnits("…。！")).toEqual([]);
  });
});

describe("groupCharacterAlignment", () => {
  it("maps character alignment to words and CJK chars", () => {
    const text = "Hi 你好";
    const characters = Array.from(text);
    const starts = characters.map((_, i) => i * 0.1);
    const ends = characters.map((_, i) => i * 0.1 + 0.1);
    const ts = groupCharacterAlignment({ characters, starts, ends });
    expect(ts).toEqual([
      { text: "Hi", startSec: 0, endSec: expect.closeTo(0.2, 5) },
      { text: "你", startSec: expect.closeTo(0.3, 5), endSec: expect.closeTo(0.4, 5) },
      { text: "好", startSec: expect.closeTo(0.4, 5), endSec: expect.closeTo(0.5, 5) },
    ]);
  });
});

describe("evenTimestamps", () => {
  it("covers the whole duration monotonically", () => {
    const ts = evenTimestamps("這是一句話 with english words", 4);
    expect(ts[0]!.startSec).toBe(0);
    expect(ts.at(-1)!.endSec).toBeCloseTo(4, 2);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!.startSec).toBeGreaterThanOrEqual(ts[i - 1]!.endSec - 1e-6);
  });
});
