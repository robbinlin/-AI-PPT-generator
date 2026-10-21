import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";

/** Nearest ancestor of cwd containing pnpm-workspace.yaml, else cwd. Lets `pnpm --filter` runs find root files. */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const REPO_ROOT = process.env.REPO_ROOT ?? findRepoRoot();
// Root .env first, then a package-local .env may override.
dotenv.config({ path: join(REPO_ROOT, ".env") });
dotenv.config({ path: join(process.cwd(), ".env"), override: true });

/** Relative paths in config are relative to the repo root, not to the process cwd. */
export function fromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  /** "localhost" binds both 127.0.0.1 and ::1 (Windows browsers resolve localhost to ::1 first). Use 0.0.0.0 in containers. */
  HOST: z.string().default("localhost"),
  LOG_LEVEL: z.string().default("info"),
  /** Empty => embedded PGlite. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default("./data/pglite"),
  STORAGE_ROOT: z.string().default("./data/storage"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:4000"),
  /** Secret used to sign asset download URLs. Random per process if unset. */
  ASSET_URL_SECRET: z.string().optional(),
  ASSET_URL_TTL_SEC: z.coerce.number().int().positive().default(3600),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  HEYGEN_API_KEY: z.string().optional(),
  /** base64, 32 bytes. Random per process (with a warning) if unset. */
  PROVIDER_KEY_ENCRYPTION_KEY: z.string().optional(),
  PARSER_PYTHON: z.string().default("python3"),
  PARSER_CLI: z.string().default("./workers/parser"),
  PARSER_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  SOFFICE_BIN: z.string().default("soffice"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  FFPROBE_BIN: z.string().default("ffprobe"),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  DEV_OWNER_ID: z.string().default("dev"),
  /** Scratch + scene cache for the render worker. */
  RENDER_WORK_DIR: z.string().default("./data/render"),
  /** Slide images attached to the outline prompt (cost control). */
  OUTLINE_MAX_IMAGES: z.coerce.number().int().min(0).default(12),
  /** Attach the slide image to each per-slide script prompt. */
  SCRIPT_ATTACH_IMAGE: z.coerce.boolean().default(true),
  /** Slides scripted concurrently. Continuity comes from the outline and neighbouring slides; the previous script is passed when already written. */
  SCRIPT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  /** Address of the self-hosted avatar service (workers/avatar-local). */
  LOCAL_AVATAR_URL: z.string().default("http://127.0.0.1:8765"),
  /** Show the offline "mock" providers in the catalogue (tests and demos only; they produce placeholder output). */
  EXPOSE_MOCK_PROVIDERS: z.coerce.boolean().default(false),
  /** Polling cadence for external avatar tasks. */
  AVATAR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  /** Lifetime of the signed audio URL handed to avatar providers (they queue for a while). */
  AVATAR_AUDIO_URL_TTL_SEC: z.coerce.number().int().positive().default(6 * 3600),
});

export type Config = z.infer<typeof EnvSchema> & {
  assetUrlSecret: string;
  providerKeyEncryptionKey: Buffer;
  warnings: string[];
};

export function loadConfig(overrides: Partial<z.input<typeof EnvSchema>> = {}): Config {
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  const warnings: string[] = [];
  // Secrets not given in .env are generated once and kept next to the database, so provider
  // keys saved in the UI and signed URLs survive restarts (a per-process random key made every
  // stored key unreadable after `git pull` + restart).
  // `.env.example` ships these as empty strings, which must count as unset.
  const envAssetSecret = env.ASSET_URL_SECRET || undefined;
  const envKeyB64 = env.PROVIDER_KEY_ENCRYPTION_KEY || undefined;
  const secretsFile = join(fromRoot(env.PGLITE_DIR), "..", "secrets.json");
  const persisted = envAssetSecret && envKeyB64 ? {} : loadOrCreateSecrets(secretsFile, warnings);
  const assetUrlSecret = envAssetSecret ?? persisted.assetUrlSecret ?? randomBytes(32).toString("hex");
  const keyB64 = envKeyB64 ?? persisted.providerKeyEncryptionKey;
  let providerKeyEncryptionKey: Buffer;
  if (keyB64) {
    providerKeyEncryptionKey = Buffer.from(keyB64, "base64");
    if (providerKeyEncryptionKey.length !== 32) {
      throw new Error("PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    }
  } else {
    providerKeyEncryptionKey = randomBytes(32);
    warnings.push("PROVIDER_KEY_ENCRYPTION_KEY unset: stored provider keys will be unreadable after restart");
  }
  const resolved = {
    ...env,
    PGLITE_DIR: fromRoot(env.PGLITE_DIR),
    STORAGE_ROOT: fromRoot(env.STORAGE_ROOT),
    PARSER_CLI: fromRoot(env.PARSER_CLI),
    RENDER_WORK_DIR: fromRoot(env.RENDER_WORK_DIR),
  };
  if (!existsSync(join(resolved.PARSER_CLI, "lvs_parser"))) {
    throw new Error(`PARSER_CLI (${resolved.PARSER_CLI}) does not contain the lvs_parser package; set PARSER_CLI to workers/parser`);
  }
  return { ...resolved, assetUrlSecret, providerKeyEncryptionKey, warnings };
}

type PersistedSecrets = { assetUrlSecret?: string; providerKeyEncryptionKey?: string };

function loadOrCreateSecrets(file: string, warnings: string[]): PersistedSecrets {
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PersistedSecrets;
      if (parsed.assetUrlSecret && parsed.providerKeyEncryptionKey) return parsed;
    }
    const fresh: PersistedSecrets = {
      assetUrlSecret: randomBytes(32).toString("hex"),
      providerKeyEncryptionKey: randomBytes(32).toString("base64"),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    return fresh;
  } catch (err) {
    warnings.push(`could not persist secrets in ${file} (${(err as Error).message}); keys saved in the UI will not survive a restart`);
    return {};
  }
}
