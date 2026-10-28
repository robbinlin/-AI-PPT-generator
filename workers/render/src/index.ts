import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RenderSpec, type RenderResult } from "@lvs/shared";
import { assemble } from "./assemble.js";
import { DEFAULT_FFPROBE, RenderAbortedError, ffprobe, probeDuration, throwIfAborted } from "./ffmpeg.js";
import { renderScene, type SceneOutput } from "./scene.js";
import { buildSrt } from "./subtitles.js";
import { computeTimeline, globalCues } from "./timeline.js";

export { assemble, buildConcatList, buildTransitionGraph, graphGoesInFile } from "./assemble.js";
export { assColor, ffmpegColor, parseHexColor } from "./color.js";
export { FfmpegError, RenderAbortedError, ffprobe, probeDuration, runFfmpeg } from "./ffmpeg.js";
export { buildSceneArgs, chromaKeyFilter, overlayPosition, renderScene, sceneCacheKey } from "./scene.js";
export type { SceneContext, SceneOutput } from "./scene.js";
export { assTime, buildAss, buildSrt, emWidth, srtTime, wrapText } from "./subtitles.js";
export { computeTimeline, globalCues } from "./timeline.js";
export type { Timeline, TimelineEntry } from "./timeline.js";

/** What callers may pass: the zod input type, i.e. defaults may be omitted. */
export type RenderSpecInput = (typeof RenderSpec)["_input"];

export interface RenderOptions {
  ffmpegBin?: string;
  ffprobeBin?: string;
  /** Scratch directory: scene files, ASS scripts, concat lists. */
  workDir: string;
  /** Scene cache (`<cacheDir>/<key>.mp4`). Defaults to `<workDir>/cache`. */
  cacheDir?: string;
  onProgress?: (p: number, msg: string) => void;
  signal?: AbortSignal;
  /** Parallel scene renders (default 2). */
  concurrency?: number;
  /** Called once per scene when its file is ready (rendered or taken from cache). */
  onSceneDone?: (scene: SceneOutput) => void;
}

/** Share of overall progress spent on per-scene rendering; the rest is assembly + probe. */
const SCENES_WEIGHT = 0.8;
const ASSEMBLE_WEIGHT = 0.18;

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      throwIfAborted(signal);
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

function validate(spec: RenderSpec): void {
  if (spec.width % 2 || spec.height % 2) {
    throw new Error(`width/height must be even for yuv420p, got ${spec.width}x${spec.height}`);
  }
  const seen = new Set<string>();
  for (const s of spec.scenes) {
    if (seen.has(s.sceneId)) throw new Error(`duplicate sceneId ${s.sceneId}`);
    seen.add(s.sceneId);
  }
}

/** Renders a `RenderSpec` to MP4 (+ optional SRT). */
export async function render(specInput: RenderSpecInput | RenderSpec, opts: RenderOptions): Promise<RenderResult> {
  const started = performance.now();
  const spec = RenderSpec.parse(specInput);
  validate(spec);

  const workDir = path.resolve(opts.workDir);
  const cacheDir = path.resolve(opts.cacheDir ?? path.join(workDir, "cache"));
  await mkdir(workDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // Child abort controller: the caller's signal, or the first scene failure, stops everything.
  const internal = new AbortController();
  const onOuterAbort = () => internal.abort();
  if (opts.signal?.aborted) throw new RenderAbortedError();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const report = opts.onProgress ?? (() => undefined);
  const timeline = computeTimeline(spec.scenes);
  const totalSceneSec = spec.scenes.reduce((s, x) => s + x.durationSec, 0);
  const sceneFrac = new Array<number>(spec.scenes.length).fill(0);
  const sceneProgress = () =>
    spec.scenes.reduce((sum, s, i) => sum + s.durationSec * (sceneFrac[i] ?? 0), 0) / totalSceneSec;

  try {
    report(0, `rendering ${spec.scenes.length} scene(s)`);
    let failure: unknown;
    const outputs = await runPool(spec.scenes, opts.concurrency ?? 2, internal.signal, async (scene, i) => {
      try {
        const out = await renderScene(scene, {
          width: spec.width,
          height: spec.height,
          fps: spec.fps,
          backgroundColor: spec.backgroundColor,
          subtitleStyle: spec.subtitleStyle,
          burnSubtitles: spec.burnSubtitles,
          workDir,
          cacheDir,
          ffmpegBin: opts.ffmpegBin,
          ffprobeBin: opts.ffprobeBin,
          signal: internal.signal,
          onProgress: (f) => {
            sceneFrac[i] = f;
            report(SCENES_WEIGHT * sceneProgress(), `scene ${i + 1}/${spec.scenes.length}`);
          },
        });
        sceneFrac[i] = 1;
        report(
          SCENES_WEIGHT * sceneProgress(),
          `scene ${i + 1}/${spec.scenes.length} ${out.cached ? "cache hit" : "rendered"}`,
        );
        opts.onSceneDone?.(out);
        return out;
      } catch (err) {
        // Remember the first real error; later ones are usually our own abort.
        if (failure === undefined) failure = err;
        internal.abort();
        throw err;
      }
    }).catch((err: unknown) => {
      if (opts.signal?.aborted) throw new RenderAbortedError();
      throw failure ?? err;
    });

    report(SCENES_WEIGHT, timeline.hasFades ? "assembling with transitions" : "concatenating scenes");
    await assemble({
      sceneFiles: outputs.map((o) => o.path),
      timeline,
      fps: spec.fps,
      outPath: spec.outputs.mp4Path,
      workDir,
      ffmpegBin: opts.ffmpegBin,
      signal: internal.signal,
      onProgress: (f) => report(SCENES_WEIGHT + ASSEMBLE_WEIGHT * f, "assembling"),
    });

    throwIfAborted(internal.signal);
    const probe = await ffprobe(spec.outputs.mp4Path, {
      bin: opts.ffprobeBin ?? DEFAULT_FFPROBE,
      signal: internal.signal,
    });
    const durationSec = probeDuration(probe);
    const tolerance = Math.max(0.5, 3 / spec.fps);
    if (Math.abs(durationSec - timeline.totalSec) > tolerance) {
      throw new Error(
        `output duration ${durationSec.toFixed(3)}s differs from expected ${timeline.totalSec.toFixed(3)}s`,
      );
    }
    const video = probe.streams.find((s) => s.codec_type === "video");

    let srtPath: string | undefined;
    if (spec.outputs.srtPath) {
      srtPath = path.resolve(spec.outputs.srtPath);
      await mkdir(path.dirname(srtPath), { recursive: true });
      await writeFile(srtPath, buildSrt(globalCues(spec.scenes, timeline)), "utf8");
    }

    const result: RenderResult = {
      mp4Path: path.resolve(spec.outputs.mp4Path),
      ...(srtPath ? { srtPath } : {}),
      durationSec: Number(durationSec.toFixed(3)),
      width: video?.width ?? spec.width,
      height: video?.height ?? spec.height,
      renderSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    };
    report(1, "done");
    return result;
  } catch (err) {
    if (opts.signal?.aborted && !(err instanceof RenderAbortedError)) throw new RenderAbortedError();
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
