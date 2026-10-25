import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/** Driver-agnostic database handle used everywhere in the API. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  driver: "pg" | "pglite";
  close(): Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

export interface DbOptions {
  /** Postgres connection string; when absent PGlite is used. */
  databaseUrl?: string;
  /** PGlite data directory; `":memory:"` or undefined => in-memory. */
  pgliteDir?: string;
}

export async function createDb(opts: DbOptions): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: opts.databaseUrl });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, driver: "pg", close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = opts.pgliteDir && opts.pgliteDir !== ":memory:" ? resolve(opts.pgliteDir) : undefined;
  if (dir) mkdirSync(dir, { recursive: true });
  // PGlite is single-process: two API instances on one directory corrupt it (and abort the WASM
  // runtime on the next start). Hold a pid lock; wait briefly for a predecessor that is shutting down.
  const releaseLock = dir ? await acquireDirLock(dir) : () => {};
  let client;
  try {
    client = dir ? new PGlite(dir) : new PGlite();
    await client.waitReady;
  } catch (err) {
    releaseLock();
    throw decoratePgliteError(err, dir);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return {
    db: db as unknown as Db,
    driver: "pglite",
    close: async () => {
      await client.close();
      releaseLock();
    },
  };
}

export { schema };

const LOCK_FILE = ".lvs-api.lock";
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 20_000;
/** Must exceed LOCK_STALE_MS so a predecessor that died just before we started always expires while we wait. */
const LOCK_WAIT_MS = 45_000;

/**
 * Creates `<dir>/.lvs-api.lock` and keeps its mtime fresh while this process runs. A lock whose
 * mtime is older than LOCK_STALE_MS belongs to a dead process (pids are reused on Windows, so
 * liveness is judged by the heartbeat, not the pid). A fresh lock means another API is really
 * running: wait a little for it to shut down (dev-server restarts overlap), then refuse.
 */
async function acquireDirLock(dir: string): Promise<() => void> {
  const lockPath = join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let announced = false;
  for (;;) {
    let ageMs = Number.POSITIVE_INFINITY;
    let holder = "?";
    if (existsSync(lockPath)) {
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
        holder = readFileSync(lockPath, "utf8").trim();
      } catch {
        ageMs = Number.POSITIVE_INFINITY;
      }
    }
    if (ageMs > LOCK_STALE_MS || holder === String(process.pid)) break;
    if (!announced) {
      console.warn(`[api] waiting for the previous API process (pid ${holder}) to release ${dir} …`);
      announced = true;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `PGlite data directory ${dir} is in use by another API process (pid ${holder}, heartbeat ${Math.round(ageMs / 1000)}s ago). ` +
          "Stop it first (close the other terminal running the API: pnpm serve:api / pnpm dev:api), or point this instance at a different PGLITE_DIR / DATABASE_URL.",
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  writeFileSync(lockPath, String(process.pid));
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      /* directory removed; nothing to do */
    }
  }, LOCK_HEARTBEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
    } catch {
      /* already gone */
    }
  };
}

function decoratePgliteError(err: unknown, dir: string | undefined): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Aborted\(\)|RuntimeError/.test(msg) && dir) {
    return new Error(
      `PGlite failed to open ${dir} (${msg}). The directory is probably corrupted, usually because two ` +
        "processes opened it at once. Move or delete it to start fresh (dev data only), or set DATABASE_URL.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}
