import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "@lvs/shared";
import { jobs, projects } from "../src/db/schema.js";
import { NonRetryableJobError } from "../src/errors.js";
import type { JobHandler } from "../src/jobs/context.js";
import { JobRunner } from "../src/jobs/runner.js";
import { createTestServer, type TestServer } from "./helpers.js";

let t: TestServer;
let projectId: string;

beforeAll(async () => {
  t = await createTestServer();
  projectId = randomUUID();
  await t.ctx.db.insert(projects).values({ id: projectId, ownerId: "dev", name: "runner", settings: {} as never });
});
afterAll(async () => {
  await t.cleanup();
});

function makeRunner(handler: JobHandler, overrides: { concurrency?: number } = {}) {
  return new JobRunner({
    db: t.ctx.db,
    storage: t.ctx.storage,
    bus: t.ctx.bus,
    config: t.ctx.config,
    parserRunner: t.parser,
    handlers: { generate_outline: handler },
    backoffBaseMs: 1,
    pollIntervalMs: 10,
    concurrency: overrides.concurrency ?? 1,
  });
}

const read = async (id: string) => (await t.ctx.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

describe("JobRunner", () => {
  it("claims the oldest queued job and runs the handler to success", async () => {
    let seen = 0;
    const runner = makeRunner(async (ctx) => {
      seen++;
      await ctx.emit(0.5, "half");
      return { ok: true };
    });
    const job = await runner.enqueue(projectId, { type: "generate_outline", force: false });
    expect(await runner.claimNext()).toMatchObject({ id: job.id, status: "running", attempts: 1 });
    expect(await runner.claimNext()).toBeNull();
    // put it back and let drain() run it
    await t.ctx.db.update(jobs).set({ status: "queued", attempts: 0 }).where(eq(jobs.id, job.id));
    await runner.drain();
    expect(seen).toBe(1);
    expect(await read(job.id)).toMatchObject({ status: "succeeded", progress: 1, result: { ok: true } });
  });

  it("retries with backoff then fails after maxAttempts", async () => {
    let calls = 0;
    const runner = makeRunner(async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    });
    const job = await runner.enqueue(projectId, { type: "generate_outline", force: false }, { maxAttempts: 3 });
    await runner.drain();
    // backoff rows become claimable after a few ms; drain again until finished
    for (let i = 0; i < 20 && (await read(job.id)).status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await runner.drain();
    }
    expect(calls).toBe(3);
    expect(await read(job.id)).toMatchObject({ status: "failed", attempts: 3 });
    expect((await read(job.id)).error).toContain("boom 3");
  });

  it("does not retry NonRetryableJobError", async () => {
    let calls = 0;
    const runner = makeRunner(async () => {
      calls++;
      throw new NonRetryableJobError("bad input");
    });
    const job = await runner.enqueue(projectId, { type: "generate_outline", force: false });
    await runner.drain();
    expect(calls).toBe(1);
    expect(await read(job.id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("dedupes identical queued jobs", async () => {
    const runner = makeRunner(async () => ({}));
    const a = await runner.enqueue(projectId, { type: "generate_outline", force: false }, { dedupeKey: "k1" });
    const b = await runner.enqueue(projectId, { type: "generate_outline", force: false }, { dedupeKey: "k1" });
    expect(b.id).toBe(a.id);
    await runner.drain();
    const c = await runner.enqueue(projectId, { type: "generate_outline", force: false }, { dedupeKey: "k1" });
    expect(c.id).not.toBe(a.id);
    await runner.drain();
  });

  it("cancels a queued job and aborts a running one", async () => {
    const runner = makeRunner(async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5000);
      });
      return { finished: !ctx.signal.aborted };
    });
    const queued = await runner.enqueue(projectId, { type: "generate_outline", force: false });
    const cancelledQueued = await runner.cancel(queued.id);
    expect(cancelledQueued?.status).toBe("cancelled");

    const running = await runner.enqueue(projectId, { type: "generate_outline", force: false });
    const drain = runner.drain();
    for (let i = 0; i < 50 && (await read(running.id)).status !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await read(running.id)).status).toBe("running");
    await runner.cancel(running.id);
    await drain;
    expect((await read(running.id)).status).toBe("cancelled");
  });

  it("publishes job events on the bus", async () => {
    const events: Job[] = [];
    const unsub = t.ctx.bus.subscribe(projectId, (e) => {
      if (e.kind === "job") events.push(e.job);
    });
    const runner = makeRunner(async () => ({}));
    const job = await runner.enqueue(projectId, { type: "generate_outline", force: false });
    await runner.drain();
    unsub();
    const statuses = events.filter((e) => e.id === job.id).map((e) => e.status);
    expect(statuses[0]).toBe("queued");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("succeeded");
  });

  it("respects concurrency", async () => {
    let inFlight = 0;
    let max = 0;
    const runner = makeRunner(
      async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return {};
      },
      { concurrency: 2 },
    );
    for (let i = 0; i < 5; i++) await runner.enqueue(projectId, { type: "generate_outline", force: false });
    await runner.drain();
    expect(max).toBe(2);
  });
});
