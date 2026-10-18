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

## Where to plug the pipeline

`buildServer({ seams })` takes a `GenerationSeams` object (`src/jobs/handlers/generation.ts`).
The handlers already load the project, pick the scenes that are `missing`/`stale`, compute the
input hash, emit progress and keep the job lifecycle correct; each seam only has to call the
provider and persist the result:

| Seam | Fill with | Must persist |
|---|---|---|
| `generateOutline({ctx, slidesInOrder, settings, inputHash})` | `@lvs/pipeline` outline step via an `LlmProvider` | `outline_revisions` row (version+1, `inputHash`), return it |
| `generateScript({ctx, scene, slide, prev, next, outline, settings})` | per-slide script step | `createScriptRevision(db, {source:"ai", inputHash: scriptInputHash(...)})` |
| `synthesizeSpeech({ctx, scene, script, settings, inputHash})` | `TtsProvider.synthesize` | `audio` asset (+ `subtitle` SRT asset from timestamps), `scenes.audio/subtitle = {status:"ready", assetId, inputHash}`, `scenes.durationSec`, `usage_records` |
| `generateAvatar({ctx, scene, audioAssetId, settings, inputHash})` | `AvatarProvider.createTask` then poll; call `ctx.setProviderTaskId` **before** polling | `avatar_video` asset, `scenes.avatar` state |
| `renderVideo({ctx, scenesInOrder, settings, inputHash, preset, burnSubtitles})` | build a `RenderSpec` (use `storage.localPath`) and call `@lvs/render` | `video` asset (+ SRT), return `{videoAssetId, srtAssetId}` |

Other seams: `buildServer({ deriveTexts })` replaces the whitespace-only
pronunciation/subtitle derivation used by `PUT …/script`; `PROVIDER_CATALOGUE` in
`src/services/providers.ts` should be replaced by the registry from `@lvs/providers`, and the
`/providers/:id/voices|avatars` routes then call `listVoices()`/`listAvatars()`.

## Tests

`pnpm --filter @lvs/api test` — PGlite in memory, temp storage, a fake parser runner; covers the
upload → parse → edit → re-upload flow, signed assets, SSE, the job runner (claim, retry,
dedupe, cancel, concurrency) and the hash/matching helpers.
