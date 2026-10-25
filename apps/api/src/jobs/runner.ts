import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Job, JobPayload, JobType, ProjectEvent } from "@lvs/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { toJob } from "../db/mappers.js";
import { jobs, sourceDocuments, type JobRow } from "../db/schema.js";
import { NonRetryableJobError, providerErrorMessage } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import type { StorageService } from "../storage/types.js";
import type { JobContext, JobHandler } from "./context.js";
import type { ParserRunner } from "./parser-runner.js";

export interface RunnerDeps {
  db: Db;
  storage: StorageService;
  bus: EventBus;
  config: Config;
  parserRunner: ParserRunner;
  handlers: Partial<Record<JobType, JobHandler>>;
  concurrency?: number;
  pollIntervalMs?: number;
  /** Backoff base in ms; retry n waits base * 2^(n-1). Tests shrink this. */
  backoffBaseMs?: number;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
}

export interface EnqueueOptions {
  dedupeKey?: string;
  maxAttempts?: number;
}

/**
 * Polls the `jobs` table and runs handlers in-process. Claiming uses
 * `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction so several API instances can
 * share one Postgres; on PGlite (single connection) the same SQL simply never contends.
 */
export class JobRunner {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private active = new Map<string, AbortController>();
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly backoffBaseMs: number;
  private wake: (() => void) | undefined;

  constructor(private readonly deps: RunnerDeps) {
    this.concurrency = deps.concurrency ?? deps.config.JOB_CONCURRENCY;
    this.pollIntervalMs = deps.pollIntervalMs ?? deps.config.JOB_POLL_INTERVAL_MS;
    this.backoffBaseMs = deps.backoffBaseMs ?? 1000;
  }

  get activeCount(): number {
    return this.active.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.recoverOrphans().finally(() => this.loop());
  }

  /**
   * Jobs left in `running` by a previous process (crash, dev-server restart) would otherwise
   * sit at their last progress forever and keep the editor's buttons disabled. Re-queue them;
   * handlers are idempotent per scene, so completed scenes are skipped on the re-run.
   */
  async recoverOrphans(): Promise<void> {
    const { db } = this.deps;
    // Each interruption counts as an attempt: a job that takes the server down with it (a deck that
    // runs it out of memory) must end as 「failed」 instead of being re-queued after every restart —
    // a stuck parse would also block replacing the deck forever.
    const gaveUp = await db
      .update(jobs)
      .set({ status: "failed", error: "這項工作進行時伺服器中斷了好幾次，已停止。請重新開始；若是簡報，可改存成 PDF 再上傳。", finishedAt: new Date() })
      .where(and(eq(jobs.status, "running"), sql`${jobs.attempts} >= ${jobs.maxAttempts}`))
      .returning();
    for (const row of gaveUp) {
      if (row.type === "parse_document") {
        await db.update(sourceDocuments).set({ parseStatus: "failed" }).where(eq(sourceDocuments.parseJobId, row.id));
      }
      this.deps.bus.publish(row.projectId, { kind: "job", job: toJob(row) });
    }
    const rows = await db
      .update(jobs)
      .set({ status: "queued", progress: 0, progressMessage: "伺服器重新啟動，重新排隊", startedAt: null })
      .where(eq(jobs.status, "running"))
      .returning();
    for (const row of rows) {
      const job = toJob(row);
      this.deps.logger?.warn({ jobId: job.id, type: job.type }, "re-queued job orphaned by a previous process");
      this.deps.bus.publish(job.projectId, { kind: "job", job });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    for (const ctrl of this.active.values()) ctrl.abort();
    // Give handlers a moment to observe the abort.
    const deadline = Date.now() + 5000;
    while (this.active.size > 0 && Date.now() < deadline) await sleep(20);
  }

  /** Trigger an immediate poll (called after enqueue). */
  poke(): void {
    this.wake?.();
  }

  async enqueue(projectId: string, payload: JobPayload, opts: EnqueueOptions = {}): Promise<Job> {
    const { db } = this.deps;
    if (opts.dedupeKey) {
      const [existing] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, projectId), eq(jobs.dedupeKey, opts.dedupeKey), eq(jobs.status, "queued")))
        .limit(1);
      if (existing) return toJob(existing);
    }
    const [row] = await db
      .insert(jobs)
      .values({
        id: randomUUID(),
        projectId,
        type: payload.type,
        status: "queued",
        payload,
        maxAttempts: opts.maxAttempts ?? 3,
        dedupeKey: opts.dedupeKey ?? null,
      })
      .returning();
    const job = toJob(row!);
    this.deps.bus.publish(projectId, { kind: "job", job });
    this.poke();
    return job;
  }

  async cancel(jobId: string): Promise<Job | null> {
    const { db } = this.deps;
    const ctrl = this.active.get(jobId);
    if (ctrl) {
      ctrl.abort();
      // The running loop finalises the row as `cancelled` when the handler returns.
      const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      return row ? toJob(row) : null;
    }
    const [row] = await db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running"])))
      .returning();
    if (!row) {
      const [existing] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      return existing ? toJob(existing) : null;
    }
    const job = toJob(row);
    // A deck stopped while still waiting: the handler never ran, so mark the document here too
    // (else the editor would show 「正在解析」 forever).
    if (job.type === "parse_document") {
      await db.update(sourceDocuments).set({ parseStatus: "cancelled" }).where(and(eq(sourceDocuments.parseJobId, jobId), inArray(sourceDocuments.parseStatus, ["queued", "running"])));
    }
    this.deps.bus.publish(job.projectId, { kind: "job", job });
    return job;
  }

  /** Claim the oldest runnable job, or null. Exposed for tests. */
  async claimNext(): Promise<JobRow | null> {
    const { db } = this.deps;
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, new Date())))
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx
        .update(jobs)
        .set({ status: "running", startedAt: new Date(), attempts: sql`${jobs.attempts} + 1`, error: null })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
        .returning();
      return claimed ?? null;
    });
  }

  /** Run until the queue is empty and no job is active. Tests use this instead of start(). */
  async drain(): Promise<void> {
    for (;;) {
      while (this.active.size < this.concurrency) {
        const row = await this.claimNext();
        if (!row) break;
        void this.execute(row);
      }
      if (this.active.size === 0) {
        const row = await this.claimNext();
        if (!row) return;
        void this.execute(row);
      }
      await sleep(10);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        while (this.running && this.active.size < this.concurrency) {
          const row = await this.claimNext();
          if (!row) break;
          void this.execute(row);
        }
      } catch (err) {
        this.deps.logger?.error({ err }, "job runner poll failed");
      }
      await new Promise<void>((resolveWait) => {
        this.wake = resolveWait;
        this.timer = setTimeout(resolveWait, this.pollIntervalMs);
      });
      this.wake = undefined;
    }
  }

  private async execute(row: JobRow): Promise<void> {
    const { db, bus, handlers, logger } = this.deps;
    const ctrl = new AbortController();
    this.active.set(row.id, ctrl);
    logger?.info({ jobId: row.id, type: row.type, projectId: row.projectId, attempt: row.attempts }, "job started");
    const publishJob = async () => {
      const [fresh] = await db.select().from(jobs).where(eq(jobs.id, row.id)).limit(1);
      if (fresh) bus.publish(fresh.projectId, { kind: "job", job: toJob(fresh) });
    };
    await publishJob();

    const ctx: JobContext = {
      job: toJob(row),
      db,
      storage: this.deps.storage,
      config: this.deps.config,
      parserRunner: this.deps.parserRunner,
      signal: ctrl.signal,
      emit: async (progress, message) => {
        await db
          .update(jobs)
          .set({ progress: Math.min(1, Math.max(0, progress)), progressMessage: message ?? null })
          .where(eq(jobs.id, row.id));
        await publishJob();
      },
      setProviderTaskId: async (id) => {
        await db.update(jobs).set({ providerTaskId: id }).where(eq(jobs.id, row.id));
      },
      publish: (event: ProjectEvent) => bus.publish(row.projectId, event),
      log: {
        info: (msg, data) => logger?.info({ jobId: row.id, data }, msg),
        warn: (msg, data) => logger?.warn({ jobId: row.id, data }, msg),
        error: (msg, data) => logger?.error({ jobId: row.id, data }, msg),
      },
    };

    const handler = handlers[row.type as JobType];
    try {
      if (!handler) throw new NonRetryableJobError(`不支援的工作類型：${row.type}`);
      const result = await handler(ctx);
      if (ctrl.signal.aborted) throw Object.assign(new Error("job cancelled"), { name: "AbortError" });
      await db
        .update(jobs)
        .set({ status: "succeeded", result, progress: 1, finishedAt: new Date(), error: null })
        .where(eq(jobs.id, row.id));
      // 「全部做完再匯出」: chain the export server-side (the user may have closed the tab).
      const then = "thenRender" in row.payload ? row.payload.thenRender : undefined;
      if (then) {
        // The finished job stays finished even if queueing the export fails.
        await this.enqueue(row.projectId, { type: "render_video", preset: then.preset, ...(then.burnSubtitles !== undefined ? { burnSubtitles: then.burnSubtitles } : {}) }).catch(
          (err: unknown) => logger?.error({ jobId: row.id, err: (err as Error).message }, "chained export could not be queued"),
        );
      }
    } catch (err) {
      const e = err as Error;
      const cancelled = ctrl.signal.aborted || e.name === "AbortError";
      const retryable = !cancelled && !(e instanceof NonRetryableJobError) && row.attempts < row.maxAttempts;
      // The stored error is shown to the user in the editor; keep the stack in the log only.
      const message = providerErrorMessage(err).slice(0, 2000);
      if (cancelled) {
        await db.update(jobs).set({ status: "cancelled", finishedAt: new Date(), error: null }).where(eq(jobs.id, row.id));
      } else if (retryable) {
        const delay = this.backoffBaseMs * 2 ** (row.attempts - 1);
        await db
          .update(jobs)
          .set({ status: "queued", error: message, runAfter: new Date(Date.now() + delay), startedAt: null })
          .where(eq(jobs.id, row.id));
        logger?.warn({ jobId: row.id, attempt: row.attempts, delay, err: e.message }, "job failed, retrying");
      } else {
        await db.update(jobs).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(jobs.id, row.id));
        logger?.error({ jobId: row.id, err: e.message, stack: e.stack }, "job failed");
      }
    } finally {
      this.active.delete(row.id);
      await publishJob();
      this.poke();
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
