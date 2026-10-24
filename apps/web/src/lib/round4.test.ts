import { describe, expect, it } from "vitest";
import { diffSnippet } from "../components/editor/ScriptHistory";
import { localizeStockName } from "../components/editor/StudioPanel";
import { confirmContent } from "./paidJobs";

describe("localizeStockName", () => {
  it("keeps the person's name and puts the scene in Chinese", () => {
    expect(localizeStockName("Dante Living Room 3")).toBe("Dante・客廳 3");
    expect(localizeStockName("Dante Office 12")).toBe("Dante・辦公室 12");
  });
  it("leaves names without a known scene alone", () => {
    expect(localizeStockName("Abigail")).toBe("Abigail");
    expect(localizeStockName("Man in black ribbed sweater")).toBe("Man in black ribbed sweater");
  });
});

describe("diffSnippet", () => {
  it("shows where an older version differs from the current text", () => {
    expect(diffSnippet("大家好，歡迎來到第五章。測試", "大家好，歡迎來到第五章。")).toBe("…歡迎來到第五章。測試");
    expect(diffSnippet("大家好", "大家好，歡迎")).toContain("比目前短");
  });
});

describe("confirmContent for 全部做完再匯出", () => {
  const estimate = { total: 10, currency: "USD", sceneCount: 5, seconds: 200, lines: [] };
  it("says the video is exported afterwards, and how", () => {
    const c = confirmContent("generate_avatar", { type: "generate_avatar", force: false, thenRender: { preset: "hd_1080p", burnSubtitles: true } }, estimate, "heygen");
    expect(c.lines.join("\n")).toContain("完成後會自動匯出影片（1080p，字幕直接印在影片上）");
    expect(c.confirmLabel).toContain("開始產生並自動匯出");
  });
  it("is unchanged without a chained export", () => {
    const c = confirmContent("generate_avatar", { type: "generate_avatar", force: false }, estimate, "heygen");
    expect(c.lines.join("\n")).not.toContain("自動匯出");
  });
});
