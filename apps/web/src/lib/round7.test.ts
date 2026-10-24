import { describe, expect, it } from "vitest";
import { statusSummary } from "../components/editor/StatusDots";
import { makeDetail } from "../test/fixtures";
import { estimateLines } from "./paidJobs";

describe("estimateLines", () => {
  it("shows script writing as one line, not one per token kind", () => {
    const lines = estimateLines({
      total: 0.021,
      currency: "USD",
      sceneCount: 3,
      lines: [
        { unit: "tokens_in", quantity: 3000, estimatedCost: 0.003 },
        { unit: "tokens_out", quantity: 1800, estimatedCost: 0.018 },
      ],
    } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("AI 寫講稿 3 頁");
  });
});

describe("statusSummary", () => {
  it("calls a script from an older outline optional, not 需更新", () => {
    const scene = makeDetail().scenes[0]!;
    const s = statusSummary({ ...scene, script: { status: "stale" }, audio: { status: "ready" }, subtitle: { status: "ready" }, avatar: { status: "ready" } });
    expect(s?.tone).toBe("muted");
    expect(s?.text).toContain("可不改");
  });

  it("still warns when narration is out of date", () => {
    const scene = makeDetail().scenes[0]!;
    const s = statusSummary({ ...scene, script: { status: "stale" }, audio: { status: "stale" }, subtitle: { status: "ready" }, avatar: { status: "ready" } });
    expect(s?.tone).toBe("warn");
  });
});
