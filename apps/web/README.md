# @lvs/web — Lecture Video Studio editor

Vite 6 + React 19 + TypeScript + Tailwind v4 + Zustand. Talks only to `apps/api` through the
DTOs in `@lvs/shared` (see `docs/API.md`). UI strings are Traditional Chinese, all in
`src/i18n/zh-TW.ts`.

## Run

```bash
pnpm install                          # at the repo root
pnpm --filter @lvs/shared build       # the web app imports @lvs/shared/dist

# Against the real API (http://localhost:4000 by default)
pnpm --filter @lvs/web dev            # http://localhost:5173
VITE_API_URL=http://api.example:4000 pnpm --filter @lvs/web dev

# Mock API only — no server needed
pnpm --filter @lvs/web dev:mock       # same as VITE_API_MOCK=1 vite
```

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` | Base URL of `apps/api`. |
| `VITE_API_MOCK` | unset | `1` forces the in-memory mock API. |

If the real API does not answer `GET /health` within 2.5 s on load, the app falls back to the
mock and shows an amber banner with a retry link. No API key or secret is ever bundled into
the browser; provider keys are entered on **設定 → 服務供應商** and sent once to the API.

### What the mock contains

`src/api/mock.ts` implements the same `ApiClient` interface as the HTTP client:

- **示範專案：機器學習導論** — 6 pages with canvas-drawn slide PNGs, scripts on pages 1–3,
  audio + subtitles ready on pages 1–2 (a generated 1-second WAV tone), page 3 edited after
  its audio was made (`stale`), an outline with glossary, and a `generate_script` job for
  pages 4–6 already running when the editor opens.
- **未命名的專案** — empty, to try the upload drop zone (any `.pptx/.ppt/.pdf` file name works;
  the mock "parses" it into 5 pages).
- Every job type is simulated on a timer and emits the same `ProjectEvent`s the real SSE
  stream sends (`job`, `scene`, `script`, `asset`, `slides`, `outline`, `project`), including
  cancel, stale propagation after script/settings edits, render → video + SRT assets, and cost
  estimates. State lives in memory and resets on reload.

## Scripts

```bash
pnpm --filter @lvs/web typecheck      # tsc (strict) for src and the Vite/Vitest configs
pnpm --filter @lvs/web test           # vitest + Testing Library (jsdom)
pnpm --filter @lvs/web build          # typecheck + production bundle in dist/
```

## Layout of `src/`

```
api/          client.ts (fetch + zod), mock.ts (+ fixtures, slide art), types.ts (ApiClient),
              assetUrls.ts (signed-URL cache), context.tsx (provider, useAssetUrl)
store/        editorStore.ts (Zustand: ProjectDetail, selection, drafts, undo/redo, playback),
              reducer.ts (pure ProjectEvent reducer), toastStore.ts
hooks/        useScriptAutosave (800 ms debounce), useEditorKeyboard, useEditorActions, useCostEstimate
components/   editor/* (header, page list, preview, player, script/settings/outline tabs, jobs, export), ui/*
pages/        ProjectsPage (/), EditorPage (/projects/:id), ProvidersPage (/settings/providers)
i18n/         zh-TW.ts — every user-facing string
lib/          formatting, scene helpers, WAV encoder
```

Keyboard in the editor: ↑/↓ change page and space plays/pauses whenever a text field is not
focused; Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (or Ctrl+Y) undo/redo inside the script box.

## Contract notes (things `@lvs/shared` does not define yet)

The client defines these locally in `src/api/types.ts` and should switch to shared schemas when
they exist:

- `GET /health` → `{ ok: true, version }`; `POST /projects/:id/source` → `{ sourceDocument, job }`;
  `POST /projects/:id/slides/reorder` → `{ slides, scenes }`; `GET …/assets/:assetId/url` →
  `{ url, expiresAt }`; `PATCH …/slides/:slideId` body `{ hidden }`.
- `Voice` / `AvatarCharacter` are TypeScript interfaces in shared, not zod schemas.
- `GET /projects` returns `Project[]` without a page count; the list reads an optional
  `pageCount` if present and otherwise shows "尚未上傳".
- There is no `SourceDocument` event; the editor follows the `parse_document` job and re-fetches
  the project when it succeeds.
- No route returns a project-level SRT directly; the export menu offers the newest `subtitle`
  asset that no scene references (what `render_video` produces).
- `ProjectSettings.deepPartial()` does not reach inside defaulted nested objects, so the settings
  form always sends whole nested sections (`voice`, `avatar`, `subtitles`).
