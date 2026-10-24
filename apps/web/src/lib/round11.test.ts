import { describe, expect, it } from "vitest";
import { useConfirm } from "../store/confirmStore";
import { makeDetail } from "../test/fixtures";
import { confirmReplaceSource } from "./replaceSource";

describe("confirmReplaceSource", () => {
  it("says how many paid presenters are at stake and that it can't be undone", async () => {
    const detail = makeDetail();
    detail.sourceDocument = { filename: "week3.pptx" } as never;
    detail.project.settings.avatar.enabled = true;
    detail.scenes[0]!.avatar = { status: "ready" } as never;
    const pending = confirmReplaceSource(detail);
    const req = useConfirm.getState().request!;
    expect(req.lines.join("\n")).toContain("已完成的人像 1 頁（已付費）");
    expect(req.lines.join("\n")).toContain("無法復原");
    useConfirm.getState().answer(false);
    expect(await pending).toBe(false);
  });
});
