import { describe, expect, it } from "vitest";
import { confirmContent } from "./paidJobs";
import { videoFileName } from "./saveFiles";

const est = { total: 0.001, currency: "USD", sceneCount: 6, seconds: 60, lines: [] } as never;

describe("forced speech rerun", () => {
  it("says finished presenter clips will have to be made again, as a danger action", () => {
    const c = confirmContent("synthesize_speech", { type: "synthesize_speech", force: true }, est, "heygen", {
      pages: 1,
      redo: { total: 1, currency: "USD", sceneCount: 1, lines: [] } as never,
    });
    expect(c.lines.join("\n")).toMatch(/1 頁已完成的人像（已付費）會因為語音改變而作廢，需要重做（約 NT\$\d+）/);
    expect(c.danger).toBe(true);
    expect(confirmContent("synthesize_speech", { type: "synthesize_speech", force: true }, est).danger).toBeUndefined();
  });
});

describe("videoFileName", () => {
  it("names quality, export time and old copies", () => {
    const at = new Date(2026, 9, 25, 14, 30);
    expect(videoFileName("運動/生理", { height: 1080, createdAt: at })).toBe("運動_生理_1080p_1025-1430.mp4");
    expect(videoFileName("課", { height: 540, createdAt: at.toISOString() }, true)).toBe("課_540p_1025-1430_舊版.mp4");
    expect(videoFileName("課")).toBe("課.mp4");
  });
});
