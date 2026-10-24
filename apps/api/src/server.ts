import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { createAuth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import type { AppContext } from "./context.js";
import { runBackfills } from "./db/backfill.js";
import { createDb, type DbHandle } from "./db/client.js";
import { ApiHttpError } from "./errors.js";
import { EventBus } from "./events/bus.js";
import { buildHandlers, type GenerationSeams } from "./jobs/handlers/index.js";
import { PythonParserRunner, type ParserRunner } from "./jobs/parser-runner.js";
import { JobRunner } from "./jobs/runner.js";
import { assetRoutes } from "./routes/assets.js";
import { healthRoutes } from "./routes/health.js";
import { projectRoutes } from "./routes/projects.js";
import { providerRoutes } from "./routes/providers.js";
import { ProviderService } from "./services/providers.js";
import { pipelineDeriveTexts, type DeriveTexts } from "./services/scripts.js";
import { createGenerationSeams } from "./services/generation.js";
import { ProviderRegistry, defaultRegistry, mockLlmFactory } from "@lvs/providers";
import { smartMockResponder } from "./services/mock-llm.js";
import { LocalStorageService } from "./storage/local.js";
import { AssetUrlSigner } from "./storage/signing.js";
import type { StorageService } from "./storage/types.js";

export interface BuildServerOptions {
  config?: Config;
  /** Reuse an existing database (tests). */
  dbHandle?: DbHandle;
  storage?: StorageService;
  parserRunner?: ParserRunner;
  /** Override the generation seams (tests); default wires @lvs/pipeline + @lvs/providers + @lvs/render. */
  seams?: GenerationSeams;
  /** Provider registry (tests inject mock responders); default `defaultRegistry`. */
  registry?: ProviderRegistry;
  deriveTexts?: DeriveTexts;
  /** Start polling immediately (default true). Tests call runner.drain() instead. */
  startRunner?: boolean;
  runnerOverrides?: { concurrency?: number; pollIntervalMs?: number; backoffBaseMs?: number };
}

export interface BuiltServer {
  app: FastifyInstance;
  ctx: AppContext;
  dbHandle: DbHandle;
  close(): Promise<void>;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<BuiltServer> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    // Lets close() cut idle keep-alive and SSE connections instead of waiting for them forever.
    forceCloseConnections: true, logger: { level: config.LOG_LEVEL }, bodyLimit: 10 * 1024 * 1024 });
  for (const w of config.warnings) app.log.warn(w);

  const dbHandle = opts.dbHandle ?? (await createDb({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR }));
  await runBackfills(dbHandle.db);
  const signer = new AssetUrlSigner(config.assetUrlSecret, config.PUBLIC_BASE_URL);
  const storage = opts.storage ?? new LocalStorageService(config.STORAGE_ROOT, signer);
  const bus = new EventBus();
  const parserRunner =
    opts.parserRunner ??
    new PythonParserRunner({ python: config.PARSER_PYTHON, cwd: config.PARSER_CLI, timeoutMs: config.PARSER_TIMEOUT_MS, sofficeBin: config.SOFFICE_BIN });
  // The default `mock` LLM answers with a prompt-aware responder so the whole flow runs offline.
  const registry = opts.registry ?? defaultRegistry.registerLlm(mockLlmFactory(smartMockResponder));
  const providers = new ProviderService(dbHandle.db, config, registry);
  const seams = opts.seams ?? createGenerationSeams({ providers, config });
  const runner = new JobRunner({
    db: dbHandle.db,
    storage,
    bus,
    config,
    parserRunner,
    handlers: buildHandlers(seams),
    logger: app.log,
    ...opts.runnerOverrides,
  });
  const ctx: AppContext = {
    config,
    db: dbHandle.db,
    storage,
    signer,
    bus,
    runner,
    auth: createAuth(config.DEV_OWNER_ID),
    providers,
    deriveTexts: opts.deriveTexts ?? pipelineDeriveTexts,
  };

  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization", "Range"],
    exposedHeaders: ["Content-Disposition", "Content-Range", "Accept-Ranges"],
  });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiHttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: "bad_request", message: "validation failed", details: err.flatten() } });
    }
    const fastifyErr = err as { statusCode?: number; code?: string; message: string };
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply.code(fastifyErr.statusCode).send({ error: { code: fastifyErr.code ?? "bad_request", message: fastifyErr.message } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: `route ${req.method} ${req.url} not found` } }),
  );

  await app.register(healthRoutes);
  await app.register(async (inst) => providerRoutes(inst, ctx));
  await app.register(async (inst) => projectRoutes(inst, ctx));
  await app.register(async (inst) => assetRoutes(inst, ctx));

  if (opts.startRunner !== false) runner.start();

  return {
    app,
    ctx,
    dbHandle,
    close: async () => {
      await runner.stop();
      await app.close();
      if (!opts.dbHandle) await dbHandle.close();
    },
  };
}
