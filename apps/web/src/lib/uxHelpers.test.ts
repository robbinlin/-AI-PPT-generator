import { describe, expect, it } from "vitest";
import type { CostEstimate, Scene } from "@lvs/shared";
import { activeFields, statusSummary } from "../components/editor/StatusDots";
import { minReadableSize } from "../components/editor/StudioPanel";
import { totalDurationLabel } from "../components/editor/Timeline";
import { formatCostTwd, formatTwdFirst, formatWait, remainingSec } from "./format";
import { confirmContent, estimateLines, needsConfirm, needsConfirmWithoutEstimate, twdShort, unknownEstimateContent } from "./paidJobs";
import { pageRanges, pickLike } from "./settingsImpact";

const est = (total: number, sceneCount: number, extra: Partial<CostEstimate> = {}): CostEstimate => ({
  lines: [],
  total,
  currency: "USD",
  sceneCount,
  ...extra,
});

describe("needsConfirm", () => {
  it("always asks before avatars, never when nothing would run", () => {
    expect(needsConfirm({ type: "generate_avatar", force: false }, est(1.2, 1))).toBe(true);
    expect(needsConfirm({ type: "generate_avatar", force: false }, est(0, 0))).toBe(false);
  });
  it("asks for forced reruns of several pages and for anything above the threshold", () => {
    expect(needsConfirm({ type: "synthesize_speech", force: true }, est(0.01, 6))).toBe(true);
    expect(needsConfirm({ type: "synthesize_speech", force: true, sceneIds: ["a"] }, est(0.01, 1))).toBe(false);
    expect(needsConfirm({ type: "synthesize_speech", force: false }, est(0.02, 5))).toBe(false);
    expect(needsConfirm({ type: "synthesize_speech", force: false }, est(0.8, 5))).toBe(true);
  });
});

describe("confirmContent", () => {
  it("lists pages, cost with NT$, the breakdown and the wait", () => {
    const e = est(10.02, 5, {
      seconds: 200,
      lines: [
        { providerId: "gemini", unit: "chars", quantity: 1036, estimatedCost: 0.02 },
        { providerId: "heygen", unit: "avatar_seconds", quantity: 200, estimatedCost: 10 },
      ],
    });
    const c = confirmContent("generate_avatar", { type: "generate_avatar", force: false }, e, "heygen");
    expect(c.title).toBe("確認產生人像");
    expect(c.lines[0]).toBe("將處理 5 頁");
    expect(c.lines[1]).toContain("約 NT$321");
    expect(c.lines.some((l) => l.includes("語音 1,036 字"))).toBe(true);
    expect(c.lines.some((l) => l.includes("人像 200 秒"))).toBe(true);
    expect(c.lines.at(-1)).toMatch(/^預估時間：約 \d+ 分鐘$/);
    expect(c.note).toContain("關掉視窗也沒關係");
    expect(c.confirmLabel).toContain("確定開始");
  });
  it("warns that a forced rerun does not refund", () => {
    const c = confirmContent("synthesize_speech", { type: "synthesize_speech", force: true }, est(0.02, 6), undefined);
    expect(c.note).toContain("不會退回");
  });
  it("skips render lines in the breakdown", () => {
    expect(estimateLines(est(0, 1, { lines: [{ providerId: "render", unit: "render_seconds", quantity: 30, estimatedCost: 0 }] }))).toEqual([]);
  });
});

describe("pickLike", () => {
  it("returns the old values at the paths a patch changes", () => {
    const prev = { voice: { voiceId: "Orus", speed: 1, providerId: "gemini" }, aspectRatio: "16:9" };
    expect(pickLike({ voice: { voiceId: "Charon", speed: 1.1 } }, prev)).toEqual({ voice: { voiceId: "Orus", speed: 1 } });
    expect(pickLike({ aspectRatio: "9:16" }, prev)).toEqual({ aspectRatio: "16:9" });
  });
});

describe("pageRanges", () => {
  it("compresses runs", () => {
    expect(pageRanges([2, 3, 4, 5, 6])).toBe("2–6");
    expect(pageRanges([5, 1, 3, 2])).toBe("1–3、5");
    expect(pageRanges([4])).toBe("4");
  });
});

describe("review fixes", () => {
  it("never starts avatars or forced reruns unasked when the estimate is unavailable", () => {
    expect(needsConfirmWithoutEstimate({ type: "generate_avatar", force: false })).toBe(true);
    expect(needsConfirmWithoutEstimate({ type: "synthesize_speech", force: true })).toBe(true);
    expect(needsConfirmWithoutEstimate({ type: "synthesize_speech", force: false })).toBe(false);
    const c = unknownEstimateContent("generate_avatar", "heygen");
    expect(c.lines.join()).toContain("無法取得預估費用");
    expect(c.lines.join()).toContain("NT$74");
    expect(c.confirmLabel).toBe("仍要開始");
  });
  it("puts NT$ first and calls zero 免費", () => {
    expect(formatTwdFirst(10.02)).toMatch(/^約 NT\$321（US\$10\.02）$/);
    expect(formatTwdFirst(0)).toBe("免費");
    expect(twdShort(10.02)).toBe("約 NT$321");
    expect(twdShort(0.004)).toBe("不到 NT$1");
    const c = confirmContent("generate_avatar", { type: "generate_avatar", force: false }, est(0, 2), "local");
    expect(c.lines[1]).toContain("免費（使用本機 GPU）");
    expect(c.confirmLabel).toBe("確定開始（免費）");
  });
  it("leaves switched-off avatar/subtitles out of the page status", () => {
    expect(activeFields({ avatar: { enabled: false }, subtitles: { enabled: true } } as never)).toEqual(["script", "audio", "subtitle"]);
    const scene = {
      script: { status: "ready" },
      audio: { status: "ready" },
      avatar: { status: "stale" },
      subtitle: { status: "ready" },
    } as unknown as Scene;
    expect(statusSummary(scene)?.text).toContain("人像");
    expect(statusSummary(scene, ["script", "audio", "subtitle"])).toBeNull();
  });
  it("flags avatars too small for readable lips and marks estimated totals", () => {
    expect(minReadableSize({ shape: "circle" })).toBe(0.35);
    expect(minReadableSize({ shape: "rect" })).toBe(0.5);
    expect(totalDurationLabel({ blocks: [{ estimated: true }], totalSec: 167 })).toBe("總長約 2:47");
    expect(totalDurationLabel({ blocks: [{ estimated: false }], totalSec: 167 })).toBe("總長 2:47");
  });
});

describe("format helpers", () => {
  it("adds NT$", () => {
    expect(formatCostTwd(12.4)).toContain("約 NT$397");
    expect(formatCostTwd(0.004)).toContain("不到 NT$1");
  });
  it("formats waits", () => {
    expect(formatWait(20)).toBe("不到 1 分鐘");
    expect(formatWait(7 * 60)).toBe("約 7 分鐘");
    expect(formatWait(70 * 60)).toBe("約 1 小時 10 分鐘");
  });
  it("extrapolates the remaining time only with enough progress", () => {
    const now = Date.parse("2026-10-23T10:10:00Z");
    expect(remainingSec("2026-10-23T10:00:00Z", 0.5, now)).toBe(600);
    expect(remainingSec("2026-10-23T10:00:00Z", 0.01, now)).toBeNull();
    expect(remainingSec("2026-10-23T10:09:55Z", 0.5, now)).toBeNull();
  });
});
