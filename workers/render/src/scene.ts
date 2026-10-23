import { constants as fsc } from "node:fs";
import { copyFile, link, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash, sha256Hex, type AvatarLayout, type RenderScene, type SubtitleStyle } from "@lvs/shared";
import { ffmpegColor } from "./color.js";
import { DEFAULT_FFMPEG, DEFAULT_FFPROBE, ffprobe, num, runFfmpeg, throwIfAborted } from "./ffmpeg.js";
import { buildAss } from "./subtitles.js";

/** Bump when the scene command line changes in a way that alters output. */
export const SCENE_RENDER_VERSION = 3;

export const VIDEO_ENCODE_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
export const AUDIO_ENCODE_ARGS = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];

export interface SceneContext {
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
  subtitleStyle: SubtitleStyle;
  burnSubtitles: boolean;
  workDir: string;
  cacheDir?: string;
  ffmpegBin?: string;
  ffprobeBin?: string;
  signal?: AbortSignal;
  /** 0..1 within this scene. */
  onProgress?: (fraction: number) => void;
}

export interface SceneOutput {
  sceneId: string;
  path: string;
  cacheKey: string;
  cached: boolean;
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

interface FileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

async function fingerprint(file: string, what: string): Promise<FileFingerprint> {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a regular file");
    return { path: path.resolve(file), size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  } catch (err) {
    throw new Error(`scene ${what} not readable: ${file} (${(err as Error).message})`);
  }
}

function avatarVisible(scene: RenderScene): boolean {
  return !!scene.avatar && scene.avatar.layout.visible !== false;
}

function sceneAss(scene: RenderScene, ctx: SceneContext): string {
  return buildAss(scene.subtitles, {
    width: ctx.width,
    height: ctx.height,
    style: ctx.subtitleStyle,
    clipEndSec: scene.durationSec,
  });
}

/** sha256 over everything that affects the pixels/samples of a scene file. */
export async function sceneCacheKey(scene: RenderScene, ctx: SceneContext): Promise<string> {
  const inputs: Record<string, FileFingerprint> = {
    image: await fingerprint(scene.imagePath, "image"),
  };
  if (scene.audioPath) inputs.audio = await fingerprint(scene.audioPath, "audio");
  if (avatarVisible(scene) && scene.avatar) inputs.avatar = await fingerprint(scene.avatar.videoPath, "avatar video");
  const burn = ctx.burnSubtitles && scene.subtitles.length > 0;
  // Transitions are applied at assembly time, so they do not affect the scene file.
  const { transitionIn: _t, transitionDurationSec: _d, ...sceneSpec } = scene;
  return contentHash({
    v: SCENE_RENDER_VERSION,
    scene: sceneSpec,
    inputs,
    width: ctx.width,
    height: ctx.height,
    fps: ctx.fps,
    backgroundColor: ctx.backgroundColor,
    burnSubtitles: burn,
    subtitleStyle: burn ? ctx.subtitleStyle : null,
    // The generated script itself, so changes to wrapping/styling logic invalidate the cache.
    ass: burn ? sha256Hex(sceneAss(scene, ctx)) : null,
    encode: [...VIDEO_ENCODE_ARGS, ...AUDIO_ENCODE_ARGS],
  });
}

/** ffmpeg `chromakey` filter for a #RRGGBB background colour (tolerant enough for compressed green screens). */
export function chromaKeyFilter(hex: string, similarity = 0.3, blend = 0.1): string {
  return `chromakey=color=${ffmpegColor(hex)}:similarity=${similarity}:blend=${blend}`;
}

/**
 * overlay x/y expressions; `W/H` = frame, `w/h` = avatar. A dragged position (`x`/`y`, centre of
 * the avatar as a frame fraction) wins over the anchor and is clamped so the avatar stays inside.
 */
export function overlayPosition(
  anchor: AvatarLayout["anchor"],
  marginPx: number,
  free?: { x?: number; y?: number },
): { x: string; y: string } {
  if (free?.x !== undefined && free?.y !== undefined) {
    const fx = num(free.x);
    const fy = num(free.y);
    // Single quotes keep the commas inside min/max from splitting the filtergraph.
    return { x: `'min(max(W*${fx}-w/2,0),W-w)'`, y: `'min(max(H*${fy}-h/2,0),H-h)'` };
  }
  const m = String(marginPx);
  switch (anchor) {
    case "bottom-left":
      return { x: m, y: `H-h-${m}` };
    case "top-right":
      return { x: `W-w-${m}`, y: m };
    case "top-left":
      return { x: m, y: m };
    case "right":
      return { x: `W-w-${m}`, y: "(H-h)/2" };
    case "left":
      return { x: m, y: "(H-h)/2" };
    case "bottom-right":
    default:
      return { x: `W-w-${m}`, y: `H-h-${m}` };
  }
}

export interface SceneCommandInput {
  scene: RenderScene;
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
  outPath: string;
  /** Bare file name of the ASS script, resolved against the ffmpeg cwd. */
  assFileName?: string;
  /** Decoder to force for the avatar (e.g. `libvpx-vp9` to keep VP9 alpha). */
  avatarDecoder?: string;
}

/** Builds the ffmpeg argument vector for one scene (pure; no I/O). */
export function buildSceneArgs(input: SceneCommandInput): string[] {
  const { scene, width: W, height: H, fps, outPath } = input;
  const args: string[] = ["-y"];
  const filters: string[] = [];
  const bg = ffmpegColor(input.backgroundColor);

  // 0: slide image, looped. With an avatar beside it the slide may be scaled down and aligned.
  args.push("-loop", "1", "-framerate", String(fps), "-i", scene.imagePath);
  const frameLayout = scene.avatar && avatarVisible(scene) ? scene.avatar.layout : undefined;
  const scale = frameLayout?.slideScale ?? 1;
  const sw = even(W * scale);
  const sh = even(H * scale);
  const inset = Math.round(H * 0.04);
  const padX = frameLayout?.slideAlign === "left" ? String(inset) : frameLayout?.slideAlign === "right" ? `ow-iw-${inset}` : "(ow-iw)/2";
  filters.push(
    `[0:v]scale=${sw}:${sh}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:${scale < 1 ? padX : "(ow-iw)/2"}:(oh-ih)/2:color=${bg},setsar=1,fps=${fps}[bg]`,
  );

  // 1: audio or generated silence.
  if (scene.audioPath) {
    args.push("-i", scene.audioPath);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  }
  filters.push("[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[aout]");

  let videoLabel = "bg";

  // 2: avatar. Clips are lip-synced to this scene's audio, so they play once from t=0 and the
  // overlay holds the last frame through the tail pause (looping would restart the talking).
  if (scene.avatar && avatarVisible(scene)) {
    const { layout, hasAlpha } = scene.avatar;
    if (input.avatarDecoder) args.push("-c:v", input.avatarDecoder);
    args.push("-i", scene.avatar.videoPath);
    const size = even(layout.size * H);
    const margin = Math.round(layout.margin * H);
    const pre = `[2:v]setpts=PTS-STARTPTS,fps=${fps}`;
    // Green-screen providers: key the background out before any mask so the disc intersects it.
    const key = scene.avatar.chromaKey ? `,format=rgba,${chromaKeyFilter(scene.avatar.chromaKey)}` : "";
    const keepAlpha = hasAlpha || !!scene.avatar.chromaKey;
    if (layout.shape === "circle") {
      filters.push(
        `${pre},scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},setsar=1${key},format=rgba[avc]`,
      );
      // One-frame anti-aliased disc, looped forever (cheaper than a per-frame geq).
      filters.push(
        `color=c=black:s=${size}x${size}:r=${fps},trim=end_frame=1,format=gray,` +
          `geq=lum='255*clip(W/2-hypot(X+0.5-W/2,Y+0.5-H/2)+0.5,0,1)',` +
          `loop=loop=-1:size=1,setpts=N/(${fps}*TB)[mask]`,
      );
      if (keepAlpha) {
        // Keep the provider's (or keyed) alpha and intersect it with the disc.
        filters.push("[avc]split[avc0][avc1]", "[avc1]alphaextract[ava]", "[ava][mask]blend=all_mode=multiply[avm]");
        filters.push("[avc0][avm]alphamerge[av]");
      } else {
        filters.push("[avc][mask]alphamerge[av]");
      }
    } else {
      // Portrait 3:4 box centred on the presenter (wide 16:9 provider clips are cropped to it),
      // matching the editor preview.
      const cw = even(size * 0.75);
      filters.push(`${pre},scale=-2:${size},crop='min(iw,${cw})':${size},setsar=1${key}${hasAlpha && !key ? ",format=rgba" : ""}[av]`);
    }
    const pos = overlayPosition(layout.anchor, margin, layout);
    filters.push(`[bg][av]overlay=x=${pos.x}:y=${pos.y}:format=auto:eof_action=repeat[ov]`);
    videoLabel = "ov";
  }

  if (input.assFileName) {
    filters.push(`[${videoLabel}]ass=filename=${input.assFileName}[sub]`);
    videoLabel = "sub";
  }
  filters.push(`[${videoLabel}]format=yuv420p[vout]`);

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    num(scene.durationSec),
    "-r",
    String(fps),
    ...VIDEO_ENCODE_ARGS,
    ...AUDIO_ENCODE_ARGS,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outPath,
  );
  return args;
}

async function avatarDecoderFor(scene: RenderScene, ffprobeBin: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!scene.avatar?.hasAlpha) return undefined;
  // ffmpeg's native VP8/VP9 decoders drop the alpha side channel; libvpx keeps it.
  const probe = await ffprobe(scene.avatar.videoPath, { bin: ffprobeBin, signal });
  const v = probe.streams.find((s) => s.codec_type === "video");
  if (v?.codec_name === "vp9") return "libvpx-vp9";
  if (v?.codec_name === "vp8") return "libvpx";
  return undefined;
}

async function linkOrCopy(src: string, dest: string): Promise<void> {
  await unlink(dest).catch(() => undefined);
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest, fsc.COPYFILE_FICLONE);
  }
}

/** Places `src` at `dest` atomically (temp file + rename). */
async function publish(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await linkOrCopy(src, tmp);
  await rename(tmp, dest);
}

/**
 * Renders one scene to `<workDir>/scenes/<sceneId>.mp4` at the spec size/fps for exactly
 * `durationSec`, or reuses `<cacheDir>/<key>.mp4` when the inputs are unchanged.
 */
export async function renderScene(scene: RenderScene, ctx: SceneContext): Promise<SceneOutput> {
  throwIfAborted(ctx.signal);
  const scenesDir = path.join(ctx.workDir, "scenes");
  await mkdir(scenesDir, { recursive: true });
  const outPath = path.join(scenesDir, `${scene.sceneId}.mp4`);
  const key = await sceneCacheKey(scene, ctx);
  const cachePath = ctx.cacheDir ? path.join(ctx.cacheDir, `${key}.mp4`) : undefined;

  if (cachePath) {
    const hit = await stat(cachePath).then((s) => s.isFile() && s.size > 0, () => false);
    if (hit) {
      await publish(cachePath, outPath);
      ctx.onProgress?.(1);
      return { sceneId: scene.sceneId, path: outPath, cacheKey: key, cached: true };
    }
  }

  let assFileName: string | undefined;
  const subsDir = path.join(ctx.workDir, "subs");
  if (ctx.burnSubtitles && scene.subtitles.length > 0) {
    await mkdir(subsDir, { recursive: true });
    // A bare, shell- and filtergraph-safe name; ffmpeg runs with cwd = subsDir so the
    // workDir path itself never has to be escaped inside the filtergraph.
    assFileName = `${key.slice(0, 32)}.ass`;
    await writeFile(path.join(subsDir, assFileName), sceneAss(scene, ctx), "utf8");
  }

  const ffprobeBin = ctx.ffprobeBin ?? DEFAULT_FFPROBE;
  const avatarDecoder = avatarVisible(scene) ? await avatarDecoderFor(scene, ffprobeBin, ctx.signal) : undefined;
  const partial = path.join(scenesDir, `${scene.sceneId}.partial.mp4`);
  const args = buildSceneArgs({
    scene: {
      ...scene,
      imagePath: path.resolve(scene.imagePath),
      audioPath: scene.audioPath ? path.resolve(scene.audioPath) : undefined,
      avatar: scene.avatar ? { ...scene.avatar, videoPath: path.resolve(scene.avatar.videoPath) } : undefined,
    },
    width: ctx.width,
    height: ctx.height,
    fps: ctx.fps,
    backgroundColor: ctx.backgroundColor,
    outPath: path.resolve(partial),
    assFileName,
    avatarDecoder,
  });

  try {
    await runFfmpeg({
      bin: ctx.ffmpegBin ?? DEFAULT_FFMPEG,
      args,
      cwd: assFileName ? subsDir : undefined,
      signal: ctx.signal,
      durationSec: scene.durationSec,
      onProgress: ctx.onProgress,
    });
  } catch (err) {
    await unlink(partial).catch(() => undefined);
    if (err instanceof Error && err.name !== "AbortError") {
      err.message = `scene ${scene.sceneId}: ${err.message}`;
    }
    throw err;
  }
  await rename(partial, outPath);

  if (cachePath && ctx.cacheDir) {
    await mkdir(ctx.cacheDir, { recursive: true });
    await publish(outPath, cachePath);
  }
  return { sceneId: scene.sceneId, path: outPath, cacheKey: key, cached: false };
}
