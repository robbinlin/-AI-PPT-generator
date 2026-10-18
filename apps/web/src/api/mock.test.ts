import { ProjectDetail, ProjectEvent, type Job } from "@lvs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectEvent } from "../store/reducer";
import { MockApiClient } from "./mock";
import { renderSvg } from "./mockImages";

const TICK = 100;

describe("MockApiClient", () => {
  let api: MockApiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    api = new MockApiClient({ tickMs: TICK, renderSlide: renderSvg });
  });

  afterEach(() => {
    api.dispose();
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  function demoId(): string {
    const id = api.demoProjectId;
    if (!id) throw new Error("no demo project");
    return id;
  }

  it("seeds a 6-page demo matching the shared ProjectDetail schema", async () => {
    const detail = ProjectDetail.parse(await api.getProject(demoId()));
    expect(detail.slides).toHaveLength(6);
    expect(Object.keys(detail.scripts)).toHaveLength(3);
    expect(detail.scenes.filter((s) => s.audio.status === "ready")).toHaveLength(2);
    expect(detail.scenes.filter((s) => s.audio.status === "stale")).toHaveLength(1);
    expect(detail.activeJobs).toHaveLength(1);
    expect(detail.activeJobs[0]?.type).toBe("generate_script");
    expect(detail.scenes.slice(3).every((s) => s.script.status === "queued")).toBe(true);

    const projects = await api.listProjects();
    expect(projects.find((p) => p.id === demoId())?.pageCount).toBe(6);
  });

  it("progresses the running job through events until scripts exist, matching a fresh snapshot", async () => {
    const id = demoId();
    let local = await api.getProject(id);
    const events: ProjectEvent[] = [];
    api.subscribe(id, (e) => {
      events.push(ProjectEvent.parse(e));
      local = applyProjectEvent(local, e);
    });

    const job = local.activeJobs[0] as Job;
    await advance(TICK);
    const firstUpdate = events.find((e) => e.kind === "job");
    expect(firstUpdate?.kind === "job" && firstUpdate.job.status).toBe("running");

    // 3 scenes × 2 steps, plus the completion tick.
    await advance(TICK * 7);
    const jobEvents = events.filter((e): e is Extract<ProjectEvent, { kind: "job" }> => e.kind === "job" && e.job.id === job.id);
    const progress = jobEvents.map((e) => e.job.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(jobEvents.at(-1)?.job.status).toBe("succeeded");
    expect(events.filter((e) => e.kind === "script")).toHaveLength(3);
    expect(events.some((e) => e.kind === "scene" && e.scene.script.status === "generating")).toBe(true);

    expect(local.activeJobs).toEqual([]);
    expect(local.scenes.every((s) => s.script.status === "ready")).toBe(true);
    expect(local).toEqual(await api.getProject(id));
  });

  it("synthesizes speech for missing/stale scenes and resolves audio to a WAV data URL", async () => {
    const id = demoId();
    await advance(TICK * 8); // let the seeded script job finish
    const { job, estimate } = await api.enqueueJob(id, { type: "synthesize_speech", force: false });
    expect(estimate?.total).toBeGreaterThan(0);
    expect(job.status).toBe("queued");
    await advance(TICK * 20);

    const detail = await api.getProject(id);
    expect(detail.scenes.every((s) => s.audio.status === "ready" && s.subtitle.status === "ready")).toBe(true);
    expect(detail.totalDurationSec).toBeGreaterThan(0);
    const assetId = detail.scenes[0]?.audio.assetId ?? "";
    const { url } = await api.getAssetUrl(id, assetId);
    expect(url.startsWith("data:audio/wav;base64,UklGR")).toBe(true); // "RIFF"
  });

  it("cancels a job and restores the scenes it had queued", async () => {
    const id = demoId();
    const before = await api.getProject(id);
    const job = before.activeJobs[0] as Job;
    await advance(TICK); // scene 4 → generating
    const cancelled = await api.cancelJob(id, job.id);
    expect(cancelled.status).toBe("cancelled");
    const after = await api.getProject(id);
    expect(after.activeJobs).toEqual([]);
    expect(after.scenes.slice(3).every((s) => s.script.status === "missing")).toBe(true);
    await advance(TICK * 10);
    expect((await api.listJobs(id)).find((j) => j.id === job.id)?.status).toBe("cancelled");
  });

  it("marks downstream assets stale when a script is edited", async () => {
    const id = demoId();
    const detail = await api.getProject(id);
    const scene = detail.scenes[0];
    if (!scene) throw new Error("fixture");
    const same = await api.updateScript(id, scene.id, { script: detail.scripts[scene.id]?.script ?? "" });
    expect(same.id).toBe(detail.scripts[scene.id]?.id);
    const rev = await api.updateScript(id, scene.id, { script: "新的講稿" });
    expect(rev.source).toBe("user");
    expect(rev.version).toBe((detail.scripts[scene.id]?.version ?? 0) + 1);
    const after = await api.getProject(id);
    expect(after.scenes[0]?.audio.status).toBe("stale");
    expect(after.scenes[0]?.subtitle.status).toBe("stale");
  });

  it("parses an uploaded deck into slides via a parse_document job", async () => {
    const project = await api.createProject({ name: "Upload", settings: { language: "en" } });
    const events: ProjectEvent[] = [];
    api.subscribe(project.id, (e) => events.push(e));
    const file = new File(["%PDF-1.7"], "lecture.pdf", { type: "application/pdf" });
    const pending = api.uploadSource(project.id, file);
    await advance(200);
    const { sourceDocument, job } = await pending;
    expect(sourceDocument.kind).toBe("pdf");
    expect(job.type).toBe("parse_document");
    await advance(TICK * 10);
    expect(events.some((e) => e.kind === "slides" && e.slides.length === 5)).toBe(true);
    const detail = await api.getProject(project.id);
    expect(detail.sourceDocument?.parseStatus).toBe("succeeded");
    expect(detail.slides).toHaveLength(5);
  });
});
