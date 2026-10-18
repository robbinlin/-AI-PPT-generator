# Architecture

Lecture Video Studio turns a slide deck (PPTX / PPT / PDF) into a narrated video with
per-slide scripts, TTS narration, an optional talking avatar and subtitles. The core idea:
**every slide is a scene with its own script, audio, avatar clip and subtitles; the video
is an assembly of scenes.** Changing slide 5's script only regenerates slide 5's assets.

## Repository map

| Path | Package | Language | Role |
|---|---|---|---|
| `packages/shared` | `@lvs/shared` | TS | Zod schemas for every entity, job payload, provider interface, HTTP DTO and worker contract. **Single source of truth.** Also emits JSON Schema to `packages/shared/schemas/` for Python. |
| `packages/providers` | `@lvs/providers` | TS | LLM / TTS / avatar provider implementations behind the interfaces in shared (`gemini`, `anthropic`, `elevenlabs`, `heygen`, plus `mock` for tests). |
| `packages/pipeline` | `@lvs/pipeline` | TS | Pure generation logic: outline → per-slide script, pronunciation/subtitle text derivation, subtitle cue building from timestamps, cost estimation. No DB, no HTTP. |
| `apps/api` | `@lvs/api` | TS (Fastify) | HTTP API, PostgreSQL (Drizzle; PGlite in dev/test), local/S3 storage, job table + in-process job runner, SSE. Invokes the parser worker as a subprocess and the render worker in-process. |
| `apps/web` | `@lvs/web` | TS (Vite + React) | Editor UI. Talks only to `apps/api` using DTOs from shared. |
| `workers/parser` | – | Python 3.13 | PPTX/PPT/PDF → page PNGs + `SlideContent` JSON + `ParserManifest`. CLI, no network. |
| `workers/render` | `@lvs/render` | TS | `RenderSpec` → MP4 + SRT via ffmpeg. CLI + library. |
| `legacy/` | – | – | The original single-page prototype, kept for reference only. Not built. |

## Data model (see `packages/shared/src/entities.ts`)

```
Project 1─1 SourceDocument 1─* Slide 1─1 Scene 1─* ScriptRevision
Project 1─* OutlineRevision          Scene ─> Asset (audio, avatar_video, subtitle)
Project 1─* Asset                    Project 1─* Job 1─* UsageRecord
Project 1─* TimelineRevision (v1: derived from scenes, read-only)
```

* `Slide` is what the parser produced (image + structured content). `Scene` is what the
  user edits (script, mute, avatar layout). They are 1:1 in v1 but kept separate so a slide
  can be re-parsed without losing scene edits, matched by `Slide.contentHash`.
* `Scene.{script,audio,avatar,subtitle}` are `SceneAssetState`s. Each stores the
  `inputHash` of the inputs that produced its asset. When the current inputs hash
  differently the state is `stale`, and the UI shows it. This is the whole "local
  regeneration" mechanism; there is no dependency graph beyond these four hashes.

### Input hashes (what invalidates what)

| Derived asset | inputHash is `contentHash` of |
|---|---|
| outline | all slides' `contentHash` in order + settings.{language, audience, audienceNote, mode, contentBoundary, targetDurationSec, styleNote, llmProviderId} |
| scene script | slide `contentHash` + outline `inputHash` + neighbouring slides' `contentHash` + the same settings subset |
| scene audio | `ScriptRevision.pronunciationText` + settings.voice (providerId, voiceId, speed, sentencePauseSec) + glossary readings + language |
| scene subtitle | audio `inputHash` + `ScriptRevision.subtitleText` + settings.subtitles.style.maxCharsPerLine |
| scene avatar | audio asset id (the exact audio file) + settings.avatar.{providerId, avatarId} + aspectRatio |
| render | ordered list of scene asset ids + layouts + subtitle style + transition + preset |

Reordering slides changes only the outline/render hashes. Changing subtitle colour changes only
the render hash. Changing a voice invalidates audio, subtitle, avatar and render for every scene.

## Job flow

```
upload ─► parse_document ─► generate_outline ─► generate_script (per scene)
        ─► synthesize_speech (per scene) ─► [generate_avatar (per scene)] ─► render_video
```

* Jobs are rows in the `jobs` table claimed with `FOR UPDATE SKIP LOCKED` by the in-process
  runner in `apps/api`. Temporal / a dedicated queue is a v2 swap behind the same table.
* A job that calls an external provider stores `providerTaskId` **before** awaiting the
  result, so a retry after a crash polls instead of re-creating (and re-paying).
* `dedupeKey` collapses identical queued jobs.
* Progress is streamed to the editor over SSE (`GET /projects/:id/events`).
* The user confirms scripts and listens to audio **before** avatar generation is offered;
  avatar is the expensive step.

## Generation wiring (apps/api/src/services/generation.ts)

| Job | Calls | Persists |
|---|---|---|
| `generate_outline` | `@lvs/pipeline.generateOutline` with up to `OUTLINE_MAX_IMAGES` slide PNGs | `outline_revisions` (version+1), `usage_records` |
| `generate_script` | `generateSceneScript` per scene in deck order, with prev/next slide, the outline, `timeAllocation[slide]` and the previous scene's script | `script_revisions` (source=ai), scene `script` state, usage |
| `synthesize_speech` | `TtsProvider.synthesize(pronunciationText)` then `buildCues` from the provider's timestamps (or proportional) | `audio` asset, `subtitle` SRT asset, `scene.subtitle.cues`, `scene.durationSec`, avatar → `stale` |
| `generate_avatar` | `AvatarProvider.createTask(audioUrl = signed /assets/:id, 6 h)`; `job.providerTaskId = "<sceneId>:<taskId>"` is written **before** polling so a retry resumes the same task | `avatar_video` asset (`producedBy.providerTaskId`), usage |
| `render_video` | builds a `RenderSpec` (local paths, cues, avatar layout, `chromaKey` for green-screen providers, fades) and runs `@lvs/render` with a per-project scene cache | `video` + `subtitle` assets, `timeline_revisions`, usage |

`PUT …/script` derives pronunciation/subtitle text with the pipeline's deterministic rules and
the latest outline's glossary, then marks audio/subtitle/avatar stale.

## Rendering (v1)

ffmpeg only, no browser. Per scene: slide PNG looped for `durationSec`, audio muxed,
avatar video overlaid (circle mask via `geq`/alpha, provider alpha, or `chromakey` for
green-screen providers such as HeyGen), subtitles burned via ASS, fade transitions via `xfade`. Scenes are rendered to intermediate MP4s (cached by
scene input hash) and concatenated. Remotion/React compositions are a v2 option for effects
bound to script words.

## Security

* Provider keys: platform keys from env; user keys stored AES-256-GCM encrypted in DB
  (`PROVIDER_KEY_ENCRYPTION_KEY`), never returned to the browser.
* Uploads validated by magic bytes, parsed in a subprocess with a timeout and a scratch dir.
* Asset downloads use short-lived signed URLs.
* All project rows carry `ownerId`; v1 uses a single dev owner until auth lands.

## Development order

1. Parser worker + API upload/parse + web page list with thumbnails. ← proves "original
   slides render correctly".
2. Outline + script generation + editor script panel. ← proves "scripts read as one lecture".
3. TTS + subtitles + per-scene playback. ← proves "zh-TW and terminology sound right".
4. Render MP4/SRT. ← first complete video.
5. Avatar provider integration. 6. Timeline editing, effects, BYO keys UI, cost estimates.
