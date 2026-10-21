# HTTP API (apps/api)

Base URL `http://localhost:4000`. JSON everywhere except upload (multipart) and asset
downloads. Errors use the `ApiError` DTO: `{ error: { code, message, details? } }`.
All DTOs are defined in `@lvs/shared` (`src/api.ts`); this file lists routes only.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/health` | – | `{ ok: true, version }` |
| GET | `/providers` | – | `ProviderInfo[]` |
| PUT | `/providers/:providerId/key` | `SetProviderKeyRequest` | `ProviderInfo` |
| DELETE | `/providers/:providerId/key` | – | `ProviderInfo` |
| GET | `/providers/:providerId/voices` | – | `Voice[]` (tts providers; `400` when no key is configured) |
| POST | `/providers/:providerId/voices/:voiceId/preview` | `?language=zh-TW\|en` | audio bytes (sample sentence) |
| POST | /providers/:providerId/characters | multipart `file` (+`name`) | AvatarCharacter (providers with customCharacters) |
| DELETE | /providers/:providerId/characters/:characterId | — | 204 |
| GET | /providers/:providerId/characters/:characterId/preview | — | image bytes |
| GET | `/providers/:providerId/avatars` | – | `AvatarCharacter[]` (avatar providers; `400` when no key is configured) |
| GET | `/projects` | – | `Project[]` |
| POST | `/projects` | `CreateProjectRequest` | `Project` |
| GET | `/projects/:id` | – | `ProjectDetail` |
| PATCH | `/projects/:id` | `UpdateProjectRequest` | `Project` |
| DELETE | `/projects/:id` | – | `204` |
| POST | `/projects/:id/source` | multipart `file` (pptx/ppt/pdf, ≤ 200 MB) | `{ sourceDocument, job }` — enqueues `parse_document` |
| POST | `/projects/:id/slides/reorder` | `ReorderSlidesRequest` | `{ slides, scenes }` |
| PATCH | `/projects/:id/slides/:slideId` | `{ hidden: boolean }` | `Slide` |
| PATCH | `/projects/:id/scenes/:sceneId` | `UpdateSceneRequest` | `Scene` |
| PUT | `/projects/:id/scenes/:sceneId/script` | `UpdateScriptRequest` | `ScriptRevision` (source=user; marks audio/subtitle/avatar stale) |
| GET | `/projects/:id/scenes/:sceneId/scripts` | – | `ScriptRevision[]` (history) |
| POST | `/projects/:id/jobs` | `EnqueueJobRequest` | `EnqueueJobResponse` |
| GET | `/projects/:id/jobs` | `?status=` | `Job[]` |
| POST | `/projects/:id/jobs/:jobId/cancel` | – | `Job` |
| GET | `/projects/:id/events` | SSE | stream of `ProjectEvent` (`event: <kind>`, `data: <json>`) |
| GET | `/projects/:id/estimate` | `?type=synthesize_speech|generate_avatar|render_video` | `CostEstimate` |
| GET | `/projects/:id/export/script` | `?format=txt|md` | file |
| GET | `/assets/:assetId` | `?sig=&exp=` (signed) | file stream; `Range` supported |
| GET | `/projects/:id/assets/:assetId/url` | – | `{ url, expiresAt }` |

Conventions

* `ProjectDetail.assets` includes every asset referenced by slides/scenes so the editor
  never needs a second fetch; asset `url`s are obtained lazily via `/assets/:id/url` or the
  API can pre-sign them when `?signed=1`.
* A `PUT …/script` with text equal to the latest revision is a no-op (returns the existing
  revision) so autosave does not create empty history.
* Enqueuing `generate_script` without `sceneIds` processes every scene whose script state
  is `missing` or `stale`; with `force: true` it processes all. Same for speech/avatar.
* The runner emits a `job` event on every status/progress change, a `scene` event when a
  scene's asset state changes, an `asset` event for every stored asset, `script` for new
  revisions and `outline` after planning.
* Provider ids are shared across kinds where one vendor key serves several (`gemini` is both an
  LLM and a TTS provider; one stored key covers both). `mock` exists for every kind and needs no
  key; it runs the whole flow offline with a prompt-aware canned responder.
* `Scene.subtitle.cues` carries the timed cues (scene-relative seconds) that the SRT asset was
  written from, so the editor can preview subtitles and the renderer burns them without
  re-parsing SRT.
* `render_video` writes the MP4 as a `video` asset and the global SRT as a `subtitle` asset;
  both ids are in the job's `result` (`videoAssetId`, `srtAssetId`). A derived
  `TimelineRevision` (one clip per scene per track) is stored at the same time.
