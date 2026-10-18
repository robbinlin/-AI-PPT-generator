import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIO_ENCODE_ARGS, VIDEO_ENCODE_ARGS } from "./scene.js";
import { DEFAULT_FFMPEG, num, runFfmpeg } from "./ffmpeg.js";
import type { Timeline } from "./timeline.js";

export interface AssembleInput {
  /** Scene files, in timeline order. */
  sceneFiles: string[];
  timeline: Timeline;
  fps: number;
  outPath: string;
  workDir: string;
  ffmpegBin?: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Quotes a path for an ffconcat `file` directive. */
export function concatQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export function buildConcatList(files: readonly string[]): string {
  return ["ffconcat version 1.0", ...files.map((f) => `file ${concatQuote(path.resolve(f))}`), ""].join("\n");
}

/**
 * Filtergraph that chains scenes with `xfade`/`acrossfade` for `fade` transitions and the
 * `concat` filter for hard cuts. Every input is first trimmed/padded to its exact duration
 * so the audio and video timelines cannot drift apart.
 */
export function buildTransitionGraph(timeline: Timeline, fps: number): string {
  const f: string[] = [];
  timeline.entries.forEach((e, i) => {
    const d = num(e.durationSec);
    f.push(`[${i}:v]trim=duration=${d},setpts=PTS-STARTPTS,settb=AVTB,fps=${fps},format=yuv420p,setsar=1[v${i}]`);
    f.push(
      `[${i}:a]atrim=duration=${d},asetpts=PTS-STARTPTS,aresample=48000,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${d}[a${i}]`,
    );
  });
  let v = "v0";
  let a = "a0";
  timeline.entries.forEach((e, i) => {
    if (i === 0) return;
    const vo = `vx${i}`;
    const ao = `ax${i}`;
    if (e.transition === "fade" && e.transitionInSec > 0) {
      const d = num(e.transitionInSec);
      f.push(`[${v}][v${i}]xfade=transition=fade:duration=${d}:offset=${num(e.startSec)}[${vo}]`);
      f.push(`[${a}][a${i}]acrossfade=d=${d}:c1=tri:c2=tri[${ao}]`);
    } else {
      f.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[${vo}][${ao}]`);
    }
    v = vo;
    a = ao;
  });
  f.push(`[${v}]format=yuv420p[vout]`);
  f.push(`[${a}]anull[aout]`);
  return f.join(";");
}

/**
 * Joins scene files into the final MP4. Hard cuts only → concat demuxer with stream copy;
 * any fade → one re-encode through an xfade/acrossfade graph.
 */
export async function assemble(input: AssembleInput): Promise<void> {
  const { timeline, outPath } = input;
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await mkdir(input.workDir, { recursive: true });
  const partial = path.resolve(`${outPath}.partial.mp4`);
  const bin = input.ffmpegBin ?? DEFAULT_FFMPEG;
  let args: string[];

  if (!timeline.hasFades) {
    const listPath = path.join(input.workDir, "concat.ffconcat");
    await writeFile(listPath, buildConcatList(input.sceneFiles), "utf8");
    args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", partial];
  } else {
    const graph = buildTransitionGraph(timeline, input.fps);
    args = ["-y"];
    for (const file of input.sceneFiles) args.push("-i", path.resolve(file));
    if (graph.length > 64_000) {
      // Stay well clear of the per-argument size limit for very long decks.
      const scriptPath = path.join(input.workDir, "assemble.filtergraph");
      await writeFile(scriptPath, graph, "utf8");
      args.push("-filter_complex_script", scriptPath);
    } else {
      args.push("-filter_complex", graph);
    }
    args.push(
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-r",
      String(input.fps),
      ...VIDEO_ENCODE_ARGS,
      ...AUDIO_ENCODE_ARGS,
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      partial,
    );
  }

  try {
    await runFfmpeg({
      bin,
      args,
      signal: input.signal,
      durationSec: timeline.totalSec,
      onProgress: input.onProgress,
    });
  } catch (err) {
    await unlink(partial).catch(() => undefined);
    throw err;
  }
  await rename(partial, path.resolve(outPath));
}
