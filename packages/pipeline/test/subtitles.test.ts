import { describe, expect, it } from "vitest";
import { SubtitleStyle } from "@lvs/shared";
import { displayWidth, splitSentences } from "../src/segment.js";
import { alignToPauses, assColor, balancedWrap, buildCues, chunkSentence, cuesToAss, cuesToSrt, formatAssTime, formatSrtTime, retextCues, segmentCueTexts, wrapCueLines } from "../src/subtitles.js";

describe("segmentation", () => {
  it("splits sentences on CJK and Latin terminators", () => {
    expect(splitSentences("第一句。第二句！Third sentence. Fourth?\n第五")).toEqual(["第一句。", "第二句！", "Third sentence.", "Fourth?", "第五"]);
    expect(splitSentences("p < .05 是顯著的。")).toEqual(["p < .05 是顯著的。"]);
  });
  it("chunks long sentences at clause punctuation within two lines", () => {
    const s = "這是一段很長的句子，裡面有很多子句，所以需要被切開，否則字幕會太長，觀眾會看不完，對吧。";
    const chunks = chunkSentence(s, 12);
    expect(chunks.join("")).toBe(s.replace(/\s/g, ""));
    for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(24);
    expect(chunks.length).toBeGreaterThan(1);
  });
  it("splits text without punctuation into even pieces, not full pieces plus a stub", () => {
    const chunks = chunkSentence("一".repeat(50), 10);
    expect(chunks.map((c) => c.length)).toEqual([17, 17, 16]);
  });
  it("English: no one-word stub cue and no lone lead-in clause (live 建立英文版 output)", () => {
    const a = "The topic we are going to explore today is the effect of High-Intensity Interval Training on Maximum Oxygen Consumption.";
    const ca = chunkSentence(a, 28);
    expect(ca.join(" ")).toBe(a);
    expect(ca.length).toBe(2);
    expect(Math.min(...ca.map((c) => c.split(" ").length))).toBeGreaterThan(5);
    const b = "In this class, we will examine relevant intervention studies to help you gain a deep understanding of the differences in physiological adaptations brought about by different training modalities.";
    const cb = chunkSentence(b, 28);
    expect(cb.join(" ")).toBe(b);
    expect(cb[0]).not.toBe("In this class,");
    for (const c of cb) expect(displayWidth(c)).toBeLessThanOrEqual(56);
    expect(balancedWrap("short", 28)).toEqual(["short"]);
  });
  it("wrapCueLines keeps a two-line cue on two lines, preferring a comma only when both halves fit", () => {
    const cue = "In this class, we will examine relevant intervention studies to help you gain a deep understanding";
    const lines = wrapCueLines(cue, 28).split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(28);
    expect(wrapCueLines("Next, let's look at the three main learning objectives for this week.", 28).split("\n")).toHaveLength(2);
  });
  it("alignToPauses leaves a mid-sentence boundary proportional instead of snapping it to a breath", () => {
    const prop = [
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ];
    expect(alignToPauses(prop, [{ startSec: 0.5, endSec: 0.8 }], 8, [false])[0]!.end).toBeCloseTo(4, 1);
    expect(alignToPauses(prop, [{ startSec: 3.6, endSec: 3.9 }], 8, [true])[0]!.end).toBeCloseTo(3.6, 2);
  });
  it("wrapCueLines breaks at a clause boundary", () => {
    expect(wrapCueLines("前半句很短，後半句也不長", 8)).toBe("前半句很短，\n後半句也不長");
    expect(wrapCueLines("短", 8)).toBe("短");
  });
  it("segmentCueTexts", () => {
    expect(segmentCueTexts("甲。乙。", 20)).toEqual(["甲。", "乙。"]);
  });
});

describe("buildCues", () => {
  it("distributes proportionally without timestamps", () => {
    const cues = buildCues({ subtitleText: "一二三四。五六七八九十一二。", durationSec: 6, maxCharsPerLine: 20, language: "zh-TW" });
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 1, startSec: 0, endSec: 2 });
    expect(cues[1]).toMatchObject({ index: 2, startSec: 2, endSec: 6 });
  });
  it("aligns to word timestamps when available", () => {
    const text = "今天好。明天見。";
    const ts = [
      { text: "今", startSec: 0.5, endSec: 0.8 },
      { text: "天", startSec: 0.8, endSec: 1.1 },
      { text: "好", startSec: 1.1, endSec: 1.6 },
      { text: "明", startSec: 2.5, endSec: 2.8 },
      { text: "天", startSec: 2.8, endSec: 3.1 },
      { text: "見", startSec: 3.1, endSec: 3.7 },
    ];
    const cues = buildCues({ subtitleText: text, timestamps: ts, durationSec: 4, maxCharsPerLine: 20, language: "zh-TW" });
    expect(cues[0]).toMatchObject({ startSec: 0.5, endSec: 1.6, text: "今天好。" });
    expect(cues[1]).toMatchObject({ startSec: 2.5, endSec: 3.7, text: "明天見。" });
    expect(cues[0]!.words).toHaveLength(3);
  });
  it("falls back gracefully when subtitle text differs from spoken text", () => {
    // spoken "V O two max" vs subtitle "VO₂max": no unit matches for that cue -> proportional
    const ts = [
      { text: "V", startSec: 0, endSec: 0.2 },
      { text: "O", startSec: 0.2, endSec: 0.4 },
      { text: "two", startSec: 0.4, endSec: 0.7 },
      { text: "max", startSec: 0.7, endSec: 1.0 },
      { text: "很", startSec: 1.2, endSec: 1.4 },
      { text: "高", startSec: 1.4, endSec: 1.8 },
    ];
    const cues = buildCues({ subtitleText: "VO₂max。很高。", timestamps: ts, durationSec: 2, maxCharsPerLine: 20, language: "mixed" });
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ startSec: 1.2, endSec: 1.8 });
    expect(cues[0]!.endSec).toBeLessThanOrEqual(cues[1]!.startSec);
  });
  it("keeps cues monotonic and within duration", () => {
    const cues = buildCues({ subtitleText: "A. B. C. D. E.", durationSec: 1, maxCharsPerLine: 20, language: "en", minCueSec: 0.4 });
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.startSec).toBeGreaterThanOrEqual(cues[i - 1]!.endSec);
    expect(cues.at(-1)!.endSec).toBeLessThanOrEqual(1);
  });
});

describe("exporters", () => {
  const cues = [
    { index: 1, startSec: 0, endSec: 1.5, text: "第一行\n第二行" },
    { index: 2, startSec: 61.25, endSec: 3600.5, text: "Hello {world}" },
  ];
  it("srt", () => {
    expect(formatSrtTime(61.25)).toBe("00:01:01,250");
    expect(cuesToSrt(cues)).toBe("1\n00:00:00,000 --> 00:00:01,500\n第一行\n第二行\n\n2\n00:01:01,250 --> 01:00:00,500\nHello {world}\n");
  });
  it("ass", () => {
    expect(formatAssTime(61.25)).toBe("0:01:01.25");
    expect(assColor("#FFFFFF", 1)).toBe("&H00FFFFFF");
    expect(assColor("#102030", 0.6)).toBe("&H66302010");
    const style = SubtitleStyle.parse({ fontFamily: "Noto Sans CJK TC", fontSizePx: 40, position: "bottom", marginPx: 48 });
    const ass = cuesToAss(cues, style, 1920, 1080);
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("Style: Default,Noto Sans CJK TC,40,&H00FFFFFF,&H00FFFFFF,&H66000000,&H66000000,0,0,0,0,100,100,0,0,3,10,0,2,96,96,48,1");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,第一行\\N第二行");
    expect(ass).toContain("Hello ｛world｝");
    expect(cuesToAss(cues, { ...style, position: "top" }, 1280, 720)).toContain(",8,64,64,48,1");
  });
});

describe("alignToPauses", () => {
  const prop = [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 },
  ];
  it("snaps cue boundaries to the nearest pauses in order", () => {
    const out = alignToPauses(prop, [{ startSec: 2.6, endSec: 2.9 }, { startSec: 6.2, endSec: 6.5 }], 9);
    expect(out.map((c) => [c.start, c.end])).toEqual([[0, 2.6], [2.9, 6.2], [6.5, 9]]);
  });
  it("ignores pauses too far from the estimate and long silences", () => {
    const out = alignToPauses(prop, [{ startSec: 0.9, endSec: 1.0 }, { startSec: 2.6, endSec: 2.9 }, { startSec: 4, endSec: 8.9 }], 9);
    expect(out[0]!.end).toBe(2.6);
    expect(out[1]!.start).toBe(2.9);
    expect(out[1]!.end).toBeCloseTo(6, 5);
  });
  it("keeps proportional timing when there are no usable pauses", () => {
    expect(alignToPauses(prop, [], 9)).toEqual(prop);
  });
  it("feeds through buildCues when no timestamps are given", () => {
    const cues = buildCues({ subtitleText: "第一句話。第二句話。第三句話。", durationSec: 9, maxCharsPerLine: 28, language: "zh-TW", pauses: [{ startSec: 2.6, endSec: 2.9 }, { startSec: 6.2, endSec: 6.5 }] });
    expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([[0, 2.6], [2.9, 6.2], [6.5, 9]]);
  });
});

describe("retextCues", () => {
  const opts = { durationSec: 6, maxCharsPerLine: 28, language: "zh-TW" as const };
  it("keeps the timing when only a character is corrected", () => {
    const old = buildCues({ subtitleText: "在連續變異數方面，存活組較重。至於類別變異數，比例較高。", durationSec: 6, maxCharsPerLine: 28, language: "zh-TW" });
    const fixed = retextCues(old, "在連續變項方面，存活組較重。至於類別變項，比例較高。", opts);
    expect(fixed.map((c) => c.text)).toEqual(["在連續變項方面，存活組較重。", "至於類別變項，比例較高。"]);
    // Same sentence boundaries in time as before (within a frame).
    expect(Math.abs(fixed[1]!.startSec - old[1]!.startSec)).toBeLessThan(0.1);
    expect(fixed.at(-1)!.endSec).toBeLessThanOrEqual(6);
  });
  it("relabels karaoke words with the corrected text when they line up, drops them otherwise", () => {
    const words = [..."兩種樣本"].map((c, i) => ({ text: c, startSec: i * 0.5, endSec: i * 0.5 + 0.5 }));
    const old = buildCues({ subtitleText: "兩種樣本", timestamps: words, durationSec: 2, maxCharsPerLine: 28, language: "zh-TW" });
    const same = retextCues(old, "兩組樣本", { ...opts, durationSec: 2 });
    expect(same[0]!.words!.map((w) => w.text)).toEqual(["兩", "組", "樣", "本"]);
    expect(same[0]!.words![1]!.startSec).toBe(0.5);
    const longer = retextCues(old, "兩組獨立樣本", { ...opts, durationSec: 2 });
    expect(longer[0]!.text).toBe("兩組獨立樣本");
    expect(longer[0]!.words).toBeUndefined();
  });
});