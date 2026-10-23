# @lvs/render

ffmpeg-only renderer: `RenderSpec` (from `@lvs/shared`) → MP4 (H.264 yuv420p + AAC 48 kHz
stereo) and optionally SRT. No browser, no native deps beyond `ffmpeg`/`ffprobe` (≥ 6, built
with libx264, libass and, for alpha avatars, libvpx).

## Library

```ts
import { render } from "@lvs/render";

const result = await render(spec, {
  workDir: "/tmp/job-123",          // scene files, ASS scripts, concat list
  cacheDir: "/var/cache/lvs-scenes", // optional, default <workDir>/cache
  ffmpegBin: "/usr/bin/ffmpeg",     // optional, default "ffmpeg" on PATH
  ffprobeBin: "/usr/bin/ffprobe",
  concurrency: 2,                   // parallel scene renders
  signal: abortController.signal,   // kills the running ffmpeg children
  onProgress: (p, msg) => {},       // p in 0..1
  onSceneDone: (s) => {},           // { sceneId, path, cacheKey, cached }
});
// → { mp4Path, srtPath?, durationSec (ffprobe), width, height, renderSeconds }
```

`spec` is parsed with the shared zod schema, so defaults (fps 30, `transitionIn: "none"`,
subtitle style, …) may be omitted.

## CLI

```
lvs-render <spec.json> [--work-dir d] [--cache-dir d] [--concurrency n] [--ffmpeg p] [--ffprobe p]
```

stderr gets `PROGRESS <0..1> <message>` lines (and `ERROR <message>` on failure); stdout gets
the `RenderResult` JSON. Exit codes: 0 ok, 1 error, 2 usage, 130 aborted (SIGINT/SIGTERM).

## How it renders

1. **Per scene** (`src/scene.ts`, one ffmpeg process each, worker pool of `concurrency`):
   slide image looped and letterboxed with `backgroundColor`; narration resampled to 48 kHz
   stereo and padded with `apad` (or `anullsrc` silence when there is no audio); output cut
   to exactly `durationSec` with `-t`. Result: `<workDir>/scenes/<sceneId>.mp4`.
   * **Avatar**: played once from the scene start (it is lip-synced to the scene audio) with the last frame held, scaled to `layout.size × height`, placed by
     `anchor` + `margin × height`. `circle` crops a square and applies an anti-aliased disc
     mask (computed once with `geq`, then looped) via `alphamerge`; with `hasAlpha` the
     provider alpha is multiplied with the disc (VP8/VP9 are decoded with libvpx so the
     alpha plane survives). `visible: false` skips the avatar entirely.
   * **Subtitles** (when `burnSubtitles` and the scene has cues): an ASS script with
     `PlayRes = frame size`, BorderStyle 3 background box (`backgroundColor` +
     `backgroundOpacity`), `position` → alignment 2/8 with `marginPx`, lines wrapped at
     `maxCharsPerLine` (CJK breaks anywhere, Latin words stay whole, closing punctuation never
     starts a line) **and** at the frame width estimated from `fontSizePx`. Burned with the
     `ass` filter; ffmpeg runs with `cwd` = the subs dir so no path ever needs filtergraph
     escaping. Cue times are relative to the scene start.
2. **Cache**: key = sha256 (`contentHash`) of the scene spec (minus transition fields), the
   size + mtime of every input file, width/height/fps, background colour, subtitle style,
   the generated ASS text and the encoder flags. A hit hard-links `<cacheDir>/<key>.mp4`
   into the scenes dir (copy fallback). Files are written to a temp name and renamed, so an
   aborted render never poisons the cache.
3. **Assembly** (`src/assemble.ts`): only hard cuts → concat demuxer with `-c copy`. Any
   `fade` → a single re-encode through an `xfade`/`acrossfade` chain (hard cuts in the same
   chain use the `concat` filter). Fade length is clamped to half of either neighbour;
   `transitionIn` on the first scene is ignored. Output duration = Σ durations − Σ overlaps
   and is checked with ffprobe.
4. **SRT**: all cues shifted by their scene's start on the output timeline (overlaps
   included), clipped to the scene, renumbered from 1.

Errors from ffmpeg include the last 40 lines of its stderr.

## Fonts

The default `SubtitleStyle.fontFamily` is `Noto Sans CJK TC`. Install it in the render image
(`fonts-noto-cjk` on Debian/Ubuntu). If it is missing, libass falls back through fontconfig
to any installed font with the needed glyphs (the tests use `WenQuanYi Zen Hei`).

## Tests

`pnpm --filter @lvs/render test` — unit tests plus end-to-end renders with the real ffmpeg
(640×360 @ 15 fps, a few seconds per case). Set `FFMPEG_BIN`/`FFPROBE_BIN` to override the
binaries and `KEEP_RENDER_TEST_OUTPUT=1` to keep the temp directory for inspection.

## Not in v1

* Karaoke highlighting (`SubtitleStyle.highlightWords`, `SubtitleCue.words`) is ignored.
* Very long decks with fades put every scene into one ffmpeg graph (fine for typical
  lecture decks; the graph spills to `-filter_complex_script` when large).
