import { describe, expect, it } from "vitest";
import { parseSilenceLog } from "../src/services/audio.js";

describe("parseSilenceLog", () => {
  it("pairs silence_start/silence_end lines", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: 2.612",
      "[silencedetect @ 0x1] silence_end: 2.901 | silence_duration: 0.289",
      "[silencedetect @ 0x1] silence_start: 6.2",
      "[silencedetect @ 0x1] silence_end: 6.5 | silence_duration: 0.3",
      "size=N/A time=00:00:09.00",
    ].join("\n");
    expect(parseSilenceLog(log)).toEqual([{ startSec: 2.612, endSec: 2.901 }, { startSec: 6.2, endSec: 6.5 }]);
  });
  it("clamps negative starts and ignores dangling starts", () => {
    expect(parseSilenceLog("silence_start: -0.02\nsilence_end: 0.3\nsilence_start: 5")).toEqual([{ startSec: 0, endSec: 0.3 }]);
  });
});
