import { describe, expect, it } from "vitest";
import { createEditorStore } from "./editorStore";
import { makeDetail, makeJob } from "../test/fixtures";

describe("upsertJob", () => {
  it("never puts a finished or running job back to 「queued」 (a late response after its events)", () => {
    const store = createEditorStore();
    const detail = makeDetail();
    store.getState().load(detail);
    const id = detail.project.id;
    const queued = makeJob(id, { type: "render_video", status: "queued" } as never);
    store.getState().upsertJob({ ...queued, status: "running" } as never);
    store.getState().upsertJob(queued);
    expect(store.getState().detail!.activeJobs.find((j) => j.id === queued.id)?.status).toBe("running");
    store.getState().upsertJob({ ...queued, status: "succeeded" } as never);
    store.getState().upsertJob(queued);
    expect(store.getState().detail!.activeJobs.some((j) => j.id === queued.id)).toBe(false);
  });
});
