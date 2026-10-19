import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Creates `<dir>/.lvs-api.lock` with our pid; waits up to ~15 s for a live predecessor to exit. */
async function acquireDirLock(dir: string): Promise<() => void> {
  const lockPath = join(dir, LOCK_FILE);
  const deadline = Date.now() + 15_000;
  for (;;) {
    let holder: number | undefined;
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, "utf8").trim();
      holder = Number(raw) || undefined;
    }
    if (holder === undefined || holder === process.pid || !pidAlive(holder)) break;
    if (Date.now() > deadline) {
      throw new Error(
        `PGlite data directory ${dir} is in use by another API process (pid ${holder}). ` +
          "Stop it first, or point this instance at a different PGLITE_DIR / DATABASE_URL.",
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  writeFileSync(lockPath, String(process.pid));
  return () => {
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
