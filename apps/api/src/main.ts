import { loadConfig } from "./config.js";
import { STOP_CRITICAL_MS } from "./jobs/runner.js";
import { buildServer } from "./server.js";

const PGLITE_HINT =
  "PGlite (embedded database) aborted. Its data directory is probably corrupted, usually because two API " +
  "processes opened it at once (e.g. a rebuild restarted the dev server while the old one was still running). " +
  "Stop every API process, then move or delete the PGlite directory (dev data only) or set DATABASE_URL.";
const fatal = (kind: string) => (err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[api] ${kind}:`, msg);
  if (/Aborted\(\)|RuntimeError/.test(msg)) console.error(`[api] ${PGLITE_HINT}`);
  console.error("[api] exited. If this window shows no prompt, press Ctrl+C, then run `pnpm serve:api` again (or `pnpm dev` from the project folder).");
  process.exit(1);
};
process.on("uncaughtException", fatal("uncaught exception"));
process.on("unhandledRejection", fatal("unhandled rejection"));

const config = loadConfig();
const server = await buildServer({ config });

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    console.error("[api] forced exit");
    process.exit(1);
  }
  shuttingDown = true;
  server.app.log.info({ signal }, "shutting down (press Ctrl+C again to force)");
  // Never hang on a provider call or an open SSE stream: exit after a bounded grace period — longer
  // than the job runner waits for a presenter task being created, so its id is stored first.
  // Closing the window: Windows ends the process about 5 s later, so wind down within that.
  const maxWaitMs = signal === "SIGHUP" ? 3500 : STOP_CRITICAL_MS;
  setTimeout(() => {
    console.error("[api] shutdown timed out; exiting");
    process.exit(0);
  }, maxWaitMs + 3000).unref();
  await server.close({ maxWaitMs });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Windows: closing the console window (SIGHUP; Windows ends the process about 5 s later) and Ctrl+Break.
process.on("SIGHUP", () => void shutdown("SIGHUP"));
process.on("SIGBREAK", () => void shutdown("SIGBREAK"));

await server.app.listen({ port: config.PORT, host: config.HOST });
server.app.log.info({ driver: server.dbHandle.driver, storage: config.STORAGE_ROOT }, "api ready");
