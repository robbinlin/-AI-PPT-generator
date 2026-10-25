import type { Job, JobPayload, ProjectEvent } from "@lvs/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { StorageService } from "../storage/types.js";
import type { ParserRunner } from "./parser-runner.js";

/** Everything a job handler may touch. Handlers must not import the server. */
export interface JobContext<P extends JobPayload = JobPayload> {
  job: Job & { payload: P };
  db: Db;
  storage: StorageService;
  config: Config;
  parserRunner: ParserRunner;
  /** Report progress in [0,1] with an optional human message; also fans out a `job` SSE event. */
  emit(progress: number, message?: string): Promise<void>;
  /** Persist an external provider task id immediately so a retry polls instead of re-creating. */
  /** null once the task's result is stored (nothing left to resume). */
  setProviderTaskId(id: string | null): Promise<void>;
  /** Publish any non-job event (scene, asset, slides, outline…) to the project's SSE stream. */
  publish(event: ProjectEvent): void;
  /** Aborted when the job is cancelled or the runner stops. */
  signal: AbortSignal;
  log: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
}

export type JobHandler<P extends JobPayload = JobPayload> = (ctx: JobContext<P>) => Promise<Record<string, unknown>>;

/** Abort reason when the server shuts down (not the user stopping the job): resume, don't discard. */
export const SHUTDOWN_ABORT = "server-shutdown";

export function abortedByShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === SHUTDOWN_ABORT;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("job cancelled");
    err.name = "AbortError";
    throw err;
  }
}
