# @lvs/api

Fastify HTTP API for Lecture Video Studio. Routes are listed in `docs/API.md`; every body
and response shape comes from `@lvs/shared`.

## Run

```bash
pnpm --filter @lvs/shared build      # once, emits dist + JSON schemas
pnpm --filter @lvs/api dev           # tsx watch, http://localhost:4000
```

Without `DATABASE_URL` the API uses embedded PGlite under `PGLITE_DIR` (default
`./data/pglite`) and local files under `STORAGE_ROOT`. Point `DATABASE_URL` at Postgres
(`docker compose up -d postgres`) for a shared instance; migrations in `drizzle/` are
applied at startup for both drivers. After changing `src/db/schema.ts` run
`pnpm --filter @lvs/api db:generate` and commit the new migration.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `4000`, `0.0.0.0` | listen address |
| `DATABASE_URL` | – | Postgres; empty => PGlite |
| `PGLITE_DIR` | `./data/pglite` | PGlite data dir |
| `STORAGE_ROOT` | `./data/storage` | local object storage root |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | prefix for signed asset URLs |
| `ASSET_URL_SECRET` | random | HMAC secret for `/assets/:id?sig&exp` (set it in prod) |
| `ASSET_URL_TTL_SEC` | `3600` | signed URL lifetime |
| `PROVIDER_KEY_ENCRYPTION_KEY` | random | base64 32-byte AES-256-GCM key for user API keys (set it in prod) |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `HEYGEN_API_KEY` | – | platform-managed provider keys |
| `PARSER_PYTHON`, `PARSER_CLI`, `PARSER_TIMEOUT_MS` | `python3`, `./workers/parser`, 10 min | parser worker invocation |
| `JOB_CONCURRENCY`, `JOB_POLL_INTERVAL_MS` | `2`, `500` | in-process job runner |
| `MAX_UPLOAD_BYTES` | 200 MiB | upload limit |
| `DEV_OWNER_ID` | `dev` | single owner until auth lands (`src/auth.ts`) |
| `RENDER_WORK_DIR` | `./data/render` | render scratch + per-project scene cache |
| `OUTLINE_MAX_IMAGES` | `12` | slide images attached to the outline prompt (0 = text only) |
| `SCRIPT_ATTACH_IMAGE` | `true` | attach the slide image to each script prompt |
| `AVATAR_POLL_INTERVAL_MS` | `5000` | polling cadence for avatar providers |
| `AVATAR_AUDIO_URL_TTL_SEC` | `21600` | lifetime of the signed audio URL handed to avatar providers |

## Layout

```
src/server.ts            buildServer(): wires db, storage, bus, runner, routes
src/main.ts              process entrypoint
src/db/{schema,client,mappers}.ts
src/storage/             StorageService (local impl, S3 stub), AssetUrlSigner
src/jobs/runner.ts       jobs table poller (FOR UPDATE SKIP LOCKED), retry/backoff, dedupe, cancel
src/jobs/hashes.ts       input hashes that decide missing | stale | ready (docs/ARCHITECTURE.md)
src/jobs/handlers/       parse_document, export_script (complete); generation handlers (seams)
src/services/            project detail, script revisions, provider keys, cost estimate
src/routes/              health, providers, projects (+slides, scenes, jobs, SSE, export), assets
```

## Generation wiring

`buildServer()` wires `src/services/generation.ts` (`createGenerationSeams`) by default: it
resolves providers from `@lvs/providers` per project settings (platform key from env or the
owner's encrypted key; `mock` needs none), calls `@lvs/pipeline` for outline / scripts /
subtitles and `@lvs/render` for the MP4, and persists assets, scene states, usage records and a
derived timeline. Tests may pass `seams` (fake implementations) or `registry` (mock providers
with custom responders, see `test/e2e.test.ts`). `src/services/mock-llm.ts` is the
prompt-aware responder behind the `mock` LLM so the whole flow runs offline.

Provider list and key storage come from the registry (`src/services/providers.ts`); the
`/providers/:id/voices|avatars` routes call the real provider and answer `400` when no key is
configured.

## Live smoke test

```bash
GEMINI_API_KEY=... pnpm --filter @lvs/api smoke:live [deck.pptx]
```

Runs parse → outline → scripts → Gemini TTS → 540p render on the fixture deck (or the given
file) with in-memory PGlite, prints the outline and the first two scripts with their
pronunciation text, and writes `data/out/smoke.mp4` + `smoke.srt`.

## Tests

`pnpm --filter @lvs/api test` — PGlite in memory, temp storage. `api.test.ts` uses a fake parser
and covers upload → parse → edit → re-upload, signed assets, SSE, providers; `runner.test.ts`
covers claim, retry, dedupe, cancel, concurrency; `e2e.test.ts` runs the real Python parser
(LibreOffice), mock LLM/TTS/avatar providers and real ffmpeg on
`fixtures/sample-exercise-physiology.pptx` end to end (about 75 s; skipped when `soffice`,
`python3` or `ffmpeg` is missing).
