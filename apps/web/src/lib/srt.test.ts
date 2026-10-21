import { describe, expect, it } from "vitest";
import { cueAt, parseSrt } from "./srt";

const SRT = `1
00:00:00,000 --> 00:00:05,236
大家好，歡迎來到描述統計單元。

2
00:00:05,619 --> 00:00:16,022
今天我們要介紹集中趨勢，
涵蓋平均數、中位數與眾數。

broken block without timing

3
00:01:04,378 --> 00:01:07,744
以及一個離群值。
`;

describe("srt", () => {
  it("parses cues and keeps line breaks", () => {
    const cues = parseSrt(SRT);
    expect(cues.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(cues[1]).toMatchObject({ startSec: 5.619, endSec: 16.022, text: "今天我們要介紹集中趨勢，\n涵蓋平均數、中位數與眾數。" });
    expect(cues[2]!.startSec).toBeCloseTo(64.378, 3);
  });
  it("picks the cue at the playhead, the first cue before playback, nothing in gaps", () => {
    const cues = parseSrt(SRT);
    expect(cueAt(cues, 0)?.index).toBe(1);
    expect(cueAt(cues, 10)?.index).toBe(2);
    expect(cueAt(cues, 5.4)).toBeUndefined();
    expect(cueAt(cues, 65)?.index).toBe(3);
    expect(cueAt([], 3)).toBeUndefined();
  });
});
