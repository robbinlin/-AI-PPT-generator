# Lecture Video Studio

Turn a slide deck (PPTX / PPT / PDF) into a narrated lecture video: per-slide AI scripts,
Taiwanese-Mandarin or English TTS, optional talking avatar, subtitles, MP4 + SRT export.
Edit one slide's script and only that slide's assets are regenerated.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, [docs/API.md](docs/API.md)
for the HTTP surface and [docs/VOAI-COMPARISON.md](docs/VOAI-COMPARISON.md) for the product
benchmark that shaped v1 scope.

## Quick start

```bash
pnpm install
cp .env.example .env            # add GEMINI_API_KEY (or ANTHROPIC_API_KEY)
python3 -m pip install -r workers/parser/requirements.txt
pnpm build                      # builds shared schemas first
pnpm dev:api                    # builds the shared packages, then serves http://localhost:4000 (PGlite, no Docker needed)
pnpm dev:web                    # http://localhost:5173
```

Optional: `docker compose up -d` for PostgreSQL + MinIO and set `DATABASE_URL`.

## Workspace

```
packages/shared     contracts (zod) → also emits JSON Schema for Python
packages/providers  LLM / TTS / avatar adapters
packages/pipeline   outline + script generation, subtitles, estimates
apps/api            Fastify API, DB, jobs, SSE
apps/web            React editor
workers/parser      Python: deck → page images + structured content
workers/render      ffmpeg: RenderSpec → MP4/SRT
legacy/             original prototype (not built)
```

`pnpm test` builds the libraries and runs every TypeScript test suite (including the
end-to-end flow on the fixture deck with mock providers); `pytest workers/parser` runs the
parser tests. `GEMINI_API_KEY=... pnpm --filter @lvs/api smoke:live` runs the same flow
against real Gemini and writes `data/out/smoke.mp4`.

No API key is needed to try the product: create a project with `llmProviderId: "mock"`,
`voice.providerId: "mock"` (and `avatar.providerId: "mock"`); the mock providers produce
deterministic scripts, silent audio and a test-pattern avatar.
