import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
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
  const assetUrlSecret = env.ASSET_URL_SECRET ?? randomBytes(32).toString("hex");
  if (!env.ASSET_URL_SECRET) warnings.push("ASSET_URL_SECRET unset: signed asset URLs will not survive a restart");
  let providerKeyEncryptionKey: Buffer;
  if (env.PROVIDER_KEY_ENCRYPTION_KEY) {
    providerKeyEncryptionKey = Buffer.from(env.PROVIDER_KEY_ENCRYPTION_KEY, "base64");
    if (providerKeyEncryptionKey.length !== 32) {
      throw new Error("PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    }
  } else {
    providerKeyEncryptionKey = randomBytes(32);
    warnings.push("PROVIDER_KEY_ENCRYPTION_KEY unset: stored provider keys will be unreadable after restart");
  }
  return { ...env, assetUrlSecret, providerKeyEncryptionKey, warnings };
}
