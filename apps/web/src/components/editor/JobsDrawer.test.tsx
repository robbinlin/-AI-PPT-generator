import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider, makeEnv } from "../../api/context";
import { MockApiClient } from "../../api/mock";
import { useConfirm } from "../../store/confirmStore";
import { editorStore } from "../../store/editorStore";
import { makeDetail, makeJob } from "../../test/fixtures";
import { JobsDrawer } from "./JobsDrawer";

function setup(type: "generate_avatar" | "synthesize_speech") {
  const detail = makeDetail();
  detail.project.settings.avatar = { ...detail.project.settings.avatar, enabled: true, providerId: "heygen", avatarId: "a1" };
  const job = makeJob(detail.project.id, { type, status: "running", progress: 0.3 } as never);
  detail.activeJobs = [job];
  act(() => editorStore.getState().load(detail));
  const actions = { cancelJob: vi.fn(async () => undefined) };
  const env = makeEnv(new MockApiClient({ seed: false }), "requested", "http://test");
  render(
    <ApiProvider env={env}>
      <JobsDrawer open onClose={() => undefined} actions={actions} />
    </ApiProvider>,
  );
  return { actions, job };
}

describe("JobsDrawer stop", () => {
  it("asks before stopping a presenter job (the clip may already be billed)", async () => {
    const { actions, job } = setup("generate_avatar");
    await userEvent.click(screen.getByRole("button", { name: "停止這項工作" }));
    const req = useConfirm.getState().request;
    expect(req?.title).toBe("停止產生人像？");
    expect(req?.lines.join(" ")).toContain("HeyGen 可能已經");
    expect(actions.cancelJob).not.toHaveBeenCalled();
    await act(async () => useConfirm.getState().answer(true));
    expect(actions.cancelJob).toHaveBeenCalledWith(job.id);
  });

  it("stops other jobs right away", async () => {
    const { actions, job } = setup("synthesize_speech");
    await userEvent.click(screen.getByRole("button", { name: "停止這項工作" }));
    expect(useConfirm.getState().request).toBeNull();
    expect(actions.cancelJob).toHaveBeenCalledWith(job.id);
  });
});
