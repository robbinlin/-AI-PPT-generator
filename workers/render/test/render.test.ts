import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render, type RenderOptions, type RenderSpecInput, type SceneOutput } from "../src/index.js";
import {
  FFMPEG,
  FFPROBE,
  colorDistance,
  grabFrame,
  makeGreenScreenVideo,
  makeTestsrcVideo,
  probe,
  tmpDir,
  writeSineWav,
  writeSolidPng,
} from "./helpers.js";

const W = 640;
const H = 360;
const FPS = 15;
const SLIDE_RGB: [number, number, number] = [0x33, 0x66, 0xcc];
const SLIDE_HEX = "#3366CC";
/** A CJK-capable font present on the test machine (no Noto CJK installed here). */
const CJK_FONT = "WenQuanYi Zen Hei";

let dir: string;
let slideA: string;
let slideB: string;

beforeAll(async () => {
  dir = await tmpDir();
  slideA = path.join(dir, "slide-a.png");
  slideB = path.join(dir, "slide-b.png");
  // Slide B is 4:3 so the letterbox path (scale + pad) is exercised as well.
  await writeSolidPng(slideA, W, H, SLIDE_RGB);
  await writeSolidPng(slideB, 400, 300, [0xdd, 0x88, 0x22]);
});

afterAll(async () => {
  if (dir && !process.env.KEEP_RENDER_TEST_OUTPUT) await rm(dir, { recursive: true, force: true });
});

function baseSpec(name: string, scenes: RenderSpecInput["scenes"], extra: Partial<RenderSpecInput> = {}): RenderSpecInput {
  return {
    schemaVersion: 1,
    width: W,
    height: H,
    fps: FPS,
    scenes,
    subtitleStyle: { fontFamily: CJK_FONT, fontSizePx: 28, marginPx: 24 },
    backgroundColor: "#000000",
    outputs: { mp4Path: path.join(dir, name, "out.mp4") },
    ...extra,
  };
}

function opts(name: string, extra: Partial<RenderOptions> = {}): RenderOptions {
  return { workDir: path.join(dir, name, "work"), ffmpegBin: FFMPEG, ffprobeBin: FFPROBE, ...extra };
}

describe("render (real ffmpeg)", () => {
  it("1. concatenates two silent scenes with hard cuts", async () => {
    const progress: number[] = [];
    const spec = baseSpec("t1", [
      { sceneId: randomUUID(), imagePath: slideA, durationSec: 2.5 },
      { sceneId: randomUUID(), imagePath: slideB, durationSec: 2.5, transitionIn: "none" },
    ]);
    const result = await render(spec, opts("t1", { onProgress: (p) => progress.push(p) }));

    expect(existsSync(result.mp4Path)).toBe(true);
    expect(result.durationSec).toBeGreaterThan(4.8);
    expect(result.durationSec).toBeLessThan(5.2);
    expect(result.width).toBe(W);
    expect(result.height).toBe(H);
    const p = await probe(result.mp4Path);
    expect(p.duration).toBeCloseTo(5, 0);
    expect(Math.abs(p.duration - 5)).toBeLessThan(0.2);
    expect(p.video).toMatchObject({ width: W, height: H, codec: "h264", pixFmt: "yuv420p" });
    expect(p.audio).toMatchObject({ codec: "aac", sampleRate: 48000, channels: 2 });
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= (progress[i - 1] ?? 0) - 1e-9)).toBe(true);
  });

  it("2. pads a 2 s narration to a 3 s scene", async () => {
    const wav = path.join(dir, "tone-2s.wav");
    await writeSineWav(wav, 2);
    const spec = baseSpec("t2", [{ sceneId: randomUUID(), imagePath: slideA, audioPath: wav, durationSec: 3 }]);
    const result = await render(spec, opts("t2"));
    const p = await probe(result.mp4Path);
    expect(p.audio).toBeDefined();
    expect(Math.abs((p.audio?.duration ?? 0) - 3)).toBeLessThan(0.1);
    expect(Math.abs(p.duration - 3)).toBeLessThan(0.2);
  });

  it("3. overlays a circular avatar at bottom-right", async () => {
    const avatar = path.join(dir, "avatar.mp4");
    await makeTestsrcVideo(avatar, 1);
    const spec = baseSpec("t3", [
      {
        sceneId: randomUUID(),
        imagePath: slideA,
        durationSec: 2,
        avatar: {
          videoPath: avatar,
          layout: { shape: "circle", anchor: "bottom-right", size: 0.3, margin: 0.03, visible: true, slideScale: 1, slideAlign: "center" },
        },
      },
    ]);
    const result = await render(spec, opts("t3"));
    // Sample after the 1 s avatar clip has looped once.
    const frame = await grabFrame(result.mp4Path, 1.5, path.join(dir, "t3", "frame.png"));
    expect(frame.width).toBe(W);

    const size = 108; // even(0.3 * 360)
    const margin = Math.round(0.03 * H); // 11
    const cx = W - margin - size / 2;
    const cy = H - margin - size / 2;
    expect(colorDistance(frame.pixel(cx, cy), SLIDE_RGB)).toBeGreaterThan(40);
    // Corner of the avatar's bounding box lies outside the disc → slide shows through.
    expect(colorDistance(frame.pixel(W - margin - size + 3, H - margin - size + 3), SLIDE_RGB)).toBeLessThan(25);
    // Far away from the avatar the slide is untouched.
    expect(colorDistance(frame.pixel(100, 100), SLIDE_RGB)).toBeLessThan(25);
  });

  it("3b. visible:false skips the avatar overlay", async () => {
    const avatar = path.join(dir, "avatar.mp4");
    if (!existsSync(avatar)) await makeTestsrcVideo(avatar, 1);
    const spec = baseSpec("t3b", [
      {
        sceneId: randomUUID(),
        imagePath: slideA,
        durationSec: 1,
        avatar: { videoPath: avatar, layout: { visible: false } },
      },
    ]);
    const result = await render(spec, opts("t3b"));
    const frame = await grabFrame(result.mp4Path, 0.5, path.join(dir, "t3b", "frame.png"));
    expect(colorDistance(frame.pixel(W - 11 - 54, H - 11 - 54), SLIDE_RGB)).toBeLessThan(25);
  });

  it("3c. keys out a green-screen avatar so the slide shows through", async () => {
    const avatar = path.join(dir, "green.mp4");
    await makeGreenScreenVideo(avatar, 1);
    const spec = baseSpec("t3c", [
      {
        sceneId: randomUUID(),
        imagePath: slideA,
        durationSec: 1,
        avatar: {
          videoPath: avatar,
          chromaKey: "#00FF00",
          layout: { shape: "rect", anchor: "bottom-right", size: 0.5, margin: 0, visible: true, slideScale: 1, slideAlign: "center" },
        },
      },
    ]);
    const result = await render(spec, opts("t3c"));
    const frame = await grabFrame(result.mp4Path, 0.5, path.join(dir, "t3c", "frame.png"));
    const size = 180; // even(0.5 * 360), square clip → 180x180 at bottom-right
    const x0 = W - size;
    const y0 = H - size;
    // Centre of the red square (60..140 of 200 → 54..126 of 180) stays red.
    const centre = frame.pixel(x0 + 90, y0 + 90);
    expect(centre[0]).toBeGreaterThan(150);
    expect(centre[1]).toBeLessThan(100);
    // The green border is keyed out → slide colour.
    expect(colorDistance(frame.pixel(x0 + 10, y0 + 10), SLIDE_RGB)).toBeLessThan(40);
    expect(colorDistance(frame.pixel(x0 + 170, y0 + 170), SLIDE_RGB)).toBeLessThan(40);
  });

  it("4. burns CJK subtitles and writes a global SRT", async () => {
    const srtPath = path.join(dir, "t4", "out.srt");
    const spec = baseSpec(
      "t4",
      [
        {
          sceneId: randomUUID(),
          imagePath: slideA,
          durationSec: 2,
          subtitles: [{ index: 1, startSec: 0.2, endSec: 1.8, text: "這是字幕測試" }],
        },
        {
          sceneId: randomUUID(),
          imagePath: slideA,
          durationSec: 2,
          subtitles: [{ index: 1, startSec: 0.5, endSec: 1.5, text: "第二句字幕" }],
        },
      ],
      { outputs: { mp4Path: path.join(dir, "t4", "out.mp4"), srtPath }, burnSubtitles: true },
    );
    const result = await render(spec, opts("t4"));
    expect(result.srtPath).toBe(srtPath);
    const srt = await readFile(srtPath, "utf8");
    expect(srt).toBe(
      [
        "1",
        "00:00:00,200 --> 00:00:01,800",
        "這是字幕測試",
        "",
        "2",
        "00:00:02,500 --> 00:00:03,500",
        "第二句字幕",
        "",
      ].join("\n"),
    );
    const p = await probe(result.mp4Path);
    expect(Math.abs(p.duration - 4)).toBeLessThan(0.2);

    // The subtitle box (semi-opaque black) darkens the bottom-centre of the slide while
    // the cue is on screen, and the slide is untouched when it is not.
    const lineY = H - 24 - 14; // marginPx + half the font size
    const on = await grabFrame(result.mp4Path, 1.0, path.join(dir, "t4", "on.png"));
    const off = await grabFrame(result.mp4Path, 1.95, path.join(dir, "t4", "off.png"));
    expect(colorDistance(on.pixel(W / 2 - 60, lineY), SLIDE_RGB)).toBeGreaterThan(40);
    expect(colorDistance(off.pixel(W / 2 - 60, lineY), SLIDE_RGB)).toBeLessThan(25);
    // The ASS script carries the CJK text and the chosen font.
    const subs = await readdir(path.join(dir, "t4", "work", "subs"));
    const ass = await readFile(path.join(dir, "t4", "work", "subs", subs[0] ?? ""), "utf8");
    expect(ass).toContain(CJK_FONT);
    expect(ass).toMatch(/Dialogue: .*(這是字幕測試|第二句字幕)/);
  });

  it("5. cross-fades three scenes", async () => {
    const srtPath = path.join(dir, "t5", "out.srt");
    const scenes = [0, 1, 2].map((i) => ({
      sceneId: randomUUID(),
      imagePath: i % 2 ? slideB : slideA,
      durationSec: 3,
      transitionIn: "fade" as const,
      transitionDurationSec: 0.4,
      subtitles: [{ index: 1, startSec: 1, endSec: 2, text: `cue ${i + 1}` }],
    }));
    const spec = baseSpec("t5", scenes, {
      outputs: { mp4Path: path.join(dir, "t5", "out.mp4"), srtPath },
      burnSubtitles: false,
    });
    const result = await render(spec, opts("t5"));
    const expected = 9 - 2 * 0.4;
    expect(Math.abs(result.durationSec - expected)).toBeLessThan(0.2);
    const p = await probe(result.mp4Path);
    expect(Math.abs(p.duration - expected)).toBeLessThan(0.2);
    expect(Math.abs((p.audio?.duration ?? 0) - expected)).toBeLessThan(0.2);
    // Scene starts are 0, 2.6, 5.2 → cue offsets follow the overlaps.
    const srt = await readFile(srtPath, "utf8");
    expect(srt).toContain("00:00:01,000 --> 00:00:02,000");
    expect(srt).toContain("00:00:03,600 --> 00:00:04,600");
    expect(srt).toContain("00:00:06,200 --> 00:00:07,200");
  });

  it("6. reuses cached scene files on a second render", async () => {
    const wav = path.join(dir, "tone-1s.wav");
    await writeSineWav(wav, 1, 660);
    const spec = baseSpec("t6", [
      { sceneId: randomUUID(), imagePath: slideA, audioPath: wav, durationSec: 2 },
      { sceneId: randomUUID(), imagePath: slideB, durationSec: 2 },
    ]);
    const cacheDir = path.join(dir, "t6", "cache");

    const first: SceneOutput[] = [];
    await render(spec, opts("t6", { cacheDir, onSceneDone: (s) => first.push(s) }));
    expect(first.map((s) => s.cached)).toEqual([false, false]);
    const cached = await readdir(cacheDir);
    expect(cached.filter((f) => f.endsWith(".mp4"))).toHaveLength(2);
    const mtimes = await Promise.all(cached.map(async (f) => (await stat(path.join(cacheDir, f))).mtimeMs));

    const second: SceneOutput[] = [];
    const messages: string[] = [];
    const result = await render(spec, opts("t6", {
      cacheDir,
      onSceneDone: (s) => second.push(s),
      onProgress: (_p, m) => messages.push(m),
    }));
    expect(second.map((s) => s.cached)).toEqual([true, true]);
    expect(second.map((s) => s.cacheKey)).toEqual(first.map((s) => s.cacheKey));
    expect(messages.filter((m) => m.includes("cache hit"))).toHaveLength(2);
    const mtimes2 = await Promise.all(cached.map(async (f) => (await stat(path.join(cacheDir, f))).mtimeMs));
    expect(mtimes2).toEqual(mtimes);
    expect(Math.abs(result.durationSec - 4)).toBeLessThan(0.2);

    // Changing one scene invalidates only that scene.
    const changed = { ...spec, scenes: [spec.scenes[0]!, { ...spec.scenes[1]!, durationSec: 2.5 }] };
    const third: SceneOutput[] = [];
    await render(changed, opts("t6", { cacheDir, onSceneDone: (s) => third.push(s) }));
    expect(third.find((s) => s.sceneId === spec.scenes[0]!.sceneId)?.cached).toBe(true);
    expect(third.find((s) => s.sceneId === spec.scenes[1]!.sceneId)?.cached).toBe(false);
  });

  it("aborts a running render and reports ffmpeg errors", async () => {
    const controller = new AbortController();
    const spec = baseSpec("t7", [{ sceneId: randomUUID(), imagePath: slideA, durationSec: 30 }]);
    const pending = render(spec, opts("t7", { signal: controller.signal, cacheDir: path.join(dir, "t7", "c") }));
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const bad = path.join(dir, "not-an-image.png");
    await writeSineWav(bad, 0.1);
    const spec2 = baseSpec("t7b", [{ sceneId: randomUUID(), imagePath: bad, durationSec: 1 }]);
    await expect(render(spec2, opts("t7b"))).rejects.toThrow(/last 40 lines of stderr/);
  });
});
