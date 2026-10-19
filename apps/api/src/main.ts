import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const PGLITE_HINT =
  "PGlite (embedded database) aborted. Its data directory is probably corrupted, usually because two API " +
  "processes opened it at once (e.g. a rebuild restarted the dev server while the old one was still running). " +
  "Stop every API process, then move or delete the PGlite directory (dev data only) or set DATABASE_URL.";
const fatal = (kind: string) => (err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[api] ${kind}:`, msg);
  if (/Aborted\(\)|RuntimeError/.test(msg)) console.error(`[api] ${PGLITE_HINT}`);
  process.exit(1);
};
process.on("uncaughtException", fatal("uncaught exception"));
process.on("unhandledRejection", fatal("unhandled rejection"));

const config = loadConfig();
const server = await buildServer({ config });

const shutdown = async (signal: string) => {
  server.app.log.info({ signal }, "shutting down");
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.app.listen({ port: config.PORT, host: config.HOST });
server.app.log.info({ driver: server.dbHandle.driver, storage: config.STORAGE_ROOT }, "api ready");
