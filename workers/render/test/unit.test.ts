import { randomUUID } from "node:crypto";
import { RenderScene, SubtitleStyle } from "@lvs/shared";
import { describe, expect, it } from "vitest";
import {
  assColor,
  assTime,
  buildAss,
  buildConcatList,
  buildSceneArgs,
  buildSrt,
  buildTransitionGraph,
  chromaKeyFilter,
  computeTimeline,
  ffmpegColor,
  globalCues,
  overlayPosition,
  srtTime,
  wrapText,
} from "../src/index.js";

const scene = (over: Partial<RenderScene> = {}): RenderScene =>
  RenderScene.parse({ sceneId: randomUUID(), imagePath: "/x/slide.png", durationSec: 3, ...over });

describe("colours", () => {
  it("converts #RRGGBB to ASS &HAABBGGRR with opacity", () => {
    expect(assColor("#FFFFFF")).toBe("&H00FFFFFF");
    expect(assColor("#112233")).toBe("&H00332211");
    expect(assColor("#000000", 0.6)).toBe("&H66000000");
    expect(assColor("#000", 0)).toBe("&HFF000000");
    expect(ffmpegColor("#3366cc")).toBe("0x3366CC");
    expect(() => ffmpegColor("red")).toThrow();
  });
});

describe("time formats", () => {
  it("formats SRT and ASS times", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(3723.4567)).toBe("01:02:03,457");
    expect(assTime(62.345)).toBe("0:01:02.35");
  });
});

describe("wrapText", () => {
  it("wraps CJK at maxChars and keeps closing punctuation off line starts", () => {
    expect(wrapText("一二三四五六七八九十", 4)).toEqual(["一二三四", "五六七八", "九十"]);
    expect(wrapText("一二三四，五六", 4)).toEqual(["一二三四，", "五六"]);
  });
  it("keeps Latin words whole and honours explicit newlines", () => {
    expect(wrapText("the quick brown fox jumps", 10)).toEqual(["the quick brown fox", "jumps"]);
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
    expect(wrapText("abcdefghijkl", 5)).toEqual(["abcdefghij", "kl"]);
    expect(wrapText("使用 Python 程式", 6)).toEqual(["使用 Python", "程式"]);
  });
  it("also caps estimated width so large fonts on small frames do not overflow", () => {
    expect(wrapText("一二三四五六", 28, 4)).toEqual(["一二三四", "五六"]);
    // 0.6 em per Latin char: "abcdef" = 3.6 em fits 4 em, "abcdefg" does not.
    expect(wrapText("abcdefg hi", 28, 4)).toEqual(["abcdef", "g hi"]);
    const ass = buildAss([{ index: 1, startSec: 0, endSec: 1, text: "一二三四五六七八九十一二三四五六七八九十" }], {
      width: 640,
      height: 360,
      style: SubtitleStyle.parse({}), // 40 px font, 28 chars → only ~14 em fit in 640 px
    });
    const text = ass.trim().split("\n").at(-1)?.split(",,").at(-1) ?? "";
    for (const line of text.split("\\N")) expect([...line].length).toBeLessThanOrEqual(14);
  });
});

describe("buildAss", () => {
  it("emits style, wrapped dialogue and escapes override braces", () => {
    const style = SubtitleStyle.parse({ maxCharsPerLine: 8, position: "top", marginPx: 30 });
    const ass = buildAss(
      [
        { index: 1, startSec: 0.5, endSec: 1.25, text: "這是一段很長的字幕需要換行" },
        { index: 2, startSec: 2, endSec: 9, text: "{\\b1}x" },
      ],
      { width: 1280, height: 720, style, clipEndSec: 3 },
    );
    expect(ass).toContain("PlayResX: 1280");
    expect(ass).toContain("PlayResY: 720");
    expect(ass).toMatch(/Style: Default,Noto Sans CJK TC,40,&H00FFFFFF,&H00FFFFFF,&H66000000,&H66000000,.*,3,\d+,0,8,\d+,\d+,30,1/);
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:01.25,Default,,0,0,0,,這是一段很長的字\\N幕需要換行");
    expect(ass).toContain("Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,｛＼b1｝x");
  });
});

describe("timeline", () => {
  it("clamps fades to half of either neighbour and offsets cues", () => {
    const scenes = [
      scene({ durationSec: 3, subtitles: [{ index: 1, startSec: 0, endSec: 1, text: "a" }] }),
      scene({ durationSec: 0.5, transitionIn: "fade", transitionDurationSec: 1 }),
      scene({ durationSec: 2, transitionIn: "none", subtitles: [{ index: 7, startSec: 0.5, endSec: 5, text: "b" }] }),
      scene({ durationSec: 2, transitionIn: "fade", transitionDurationSec: 0.4 }),
    ];
    const t = computeTimeline(scenes);
    expect(t.entries.map((e) => e.transitionInSec)).toEqual([0, 0.25, 0, 0.4]);
    expect(t.entries.map((e) => e.startSec)).toEqual([0, 2.75, 3.25, 4.85]);
    expect(t.totalSec).toBeCloseTo(6.85, 6);
    expect(t.hasFades).toBe(true);
    const cues = globalCues(scenes, t);
    expect(cues).toEqual([
      { startSec: 0, endSec: 1, text: "a" },
      { startSec: 3.75, endSec: 5.25, text: "b" },
    ]);
    expect(buildSrt(cues)).toBe("1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:03,750 --> 00:00:05,250\nb\n");
  });

  it("ignores transitionIn of the first scene", () => {
    const t = computeTimeline([scene({ transitionIn: "fade" }), scene()]);
    expect(t.hasFades).toBe(false);
    expect(t.totalSec).toBe(6);
  });

  it("builds an xfade/acrossfade graph with concat for hard cuts", () => {
    const t = computeTimeline([scene(), scene({ transitionIn: "fade" }), scene({ transitionIn: "none" })]);
    const g = buildTransitionGraph(t, 30);
    expect(g).toContain("[v0][v1]xfade=transition=fade:duration=0.4:offset=2.6[vx1]");
    expect(g).toContain("[a0][a1]acrossfade=d=0.4:c1=tri:c2=tri[ax1]");
    expect(g).toContain("[vx1][ax1][v2][a2]concat=n=2:v=1:a=1[vx2][ax2]");
  });
});

describe("command building", () => {
  it("quotes concat list paths", () => {
    // Paths are resolved (C:... on Windows); what matters is the escaped apostrophe.
    expect(buildConcatList(["/tmp/it's here.mp4"])).toContain("it'\\''s here.mp4'");
  });

  it("positions the avatar by anchor", () => {
    expect(overlayPosition("bottom-right", 10)).toEqual({ x: "W-w-10", y: "H-h-10" });
    expect(overlayPosition("top-left", 5)).toEqual({ x: "5", y: "5" });
    expect(overlayPosition("left", 5)).toEqual({ x: "5", y: "(H-h)/2" });
  });

  it("generates silence, letterbox and exact duration", () => {
    const args = buildSceneArgs({
      scene: scene({ durationSec: 2.5 }),
      width: 1920,
      height: 1080,
      fps: 30,
      backgroundColor: "#102030",
      outPath: "/out/s.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    expect(graph).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x102030");
    expect(graph).toContain("apad[aout]");
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "2.5"]);
    expect(args.join(" ")).toContain(
      "-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart",
    );
  });

  it("keeps provider alpha for circle avatars", () => {
    const args = buildSceneArgs({
      scene: scene({
        avatar: { videoPath: "/a.webm", hasAlpha: true, layout: { shape: "circle", anchor: "top-right", size: 0.25, margin: 0.02, visible: true, slideScale: 1, slideAlign: "center" } },
      }),
      width: 1280,
      height: 720,
      fps: 25,
      backgroundColor: "#000",
      outPath: "/o.mp4",
      avatarDecoder: "libvpx-vp9",
    });
    const joined = args.join(" ");
    expect(joined).toContain("-c:v libvpx-vp9 -stream_loop -1 -i /a.webm");
    expect(joined).toContain("alphaextract");
    expect(joined).toContain("blend=all_mode=multiply");
    expect(joined).toContain("overlay=x=W-w-14:y=14");
  });

  it("keys out a green screen before the circle mask", () => {
    expect(chromaKeyFilter("#00FF00")).toBe("chromakey=color=0x00FF00:similarity=0.3:blend=0.1");
    const circle = buildSceneArgs({
      scene: scene({
        avatar: { videoPath: "/a.mp4", hasAlpha: false, chromaKey: "#00ff00", layout: { shape: "circle", anchor: "bottom-right", size: 0.3, margin: 0.03, visible: true, slideScale: 1, slideAlign: "center" } },
      }),
      width: 1280,
      height: 720,
      fps: 25,
      backgroundColor: "#000",
      outPath: "/o.mp4",
    });
    const graph = circle[circle.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("crop=216:216,setsar=1,format=rgba,chromakey=color=0x00FF00:similarity=0.3:blend=0.1,format=rgba[avc]");
    expect(graph).toContain("alphaextract");
    expect(graph).toContain("blend=all_mode=multiply");
    const rect = buildSceneArgs({
      scene: scene({ avatar: { videoPath: "/a.mp4", hasAlpha: false, chromaKey: "#00FF00", layout: { shape: "rect", anchor: "left", size: 0.5, margin: 0, visible: true, slideScale: 1, slideAlign: "center" } } }),
      width: 640,
      height: 360,
      fps: 15,
      backgroundColor: "#000",
      outPath: "/o.mp4",
    });
    const rectGraph = rect[rect.indexOf("-filter_complex") + 1]!;
    expect(rectGraph).toContain("scale=-2:180,crop='min(iw,136)':180,setsar=1,format=rgba,chromakey=color=0x00FF00:similarity=0.3:blend=0.1[av]");
    expect(rectGraph).not.toContain("alphaextract");
  });
});

describe("editor layouts", () => {
  const base = { shape: "rect" as const, anchor: "bottom-right" as const, size: 0.7, margin: 0, visible: true };
  const mk = (layout: Record<string, unknown>) =>
    buildSceneArgs({
      scene: scene({ avatar: { videoPath: "/a.mp4", hasAlpha: false, layout: { ...base, slideScale: 1, slideAlign: "center", ...layout } as never } }),
      width: 1920,
      height: 1080,
      fps: 25,
      backgroundColor: "#112233",
      outPath: "/o.mp4",
    });

  it("places a dragged avatar by its centre and clamps it inside the frame", () => {
    expect(overlayPosition("bottom-right", 10, { x: 0.25, y: 0.5 })).toEqual({
      x: "'min(max(W*0.25-w/2,0),W-w)'",
      y: "'min(max(H*0.5-h/2,0),H-h)'",
    });
    // half-set positions fall back to the anchor
    expect(overlayPosition("top-left", 5, { x: 0.3 })).toEqual({ x: "5", y: "5" });
    const graph = mk({ x: 0.85, y: 0.6 }).join(" ");
    expect(graph).toContain("overlay=x='min(max(W*0.85-w/2,0),W-w)':y='min(max(H*0.6-h/2,0),H-h)'");
  });

  it("scales the slide down and aligns it to leave room for the avatar", () => {
    const left = mk({ slideScale: 0.75, slideAlign: "left" });
    const g = left[left.indexOf("-filter_complex") + 1]!;
    expect(g).toContain("[0:v]scale=1440:810:force_original_aspect_ratio=decrease,pad=1920:1080:43:(oh-ih)/2:color=0x112233");
    const right = mk({ slideScale: 0.75, slideAlign: "right" });
    expect(right[right.indexOf("-filter_complex") + 1]).toContain("pad=1920:1080:ow-iw-43:(oh-ih)/2");
    const full = mk({});
    expect(full[full.indexOf("-filter_complex") + 1]).toContain("[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2");
  });
});

describe("outlined subtitles", () => {
  it("uses an outline instead of the box when the background is transparent", () => {
    const style = SubtitleStyle.parse({ backgroundOpacity: 0, outlineWidthPx: 3, outlineColor: "#000000", bold: true, color: "#FFD60A" });
    const ass = buildAss([{ index: 1, startSec: 0, endSec: 1, text: "測試" }], { width: 1920, height: 1080, style });
    const line = ass.split("\n").find((l) => l.startsWith("Style: Default"))!;
    const f = line.split(",");
    expect(f[7]).toBe("-1"); // bold
    expect(f[15]).toBe("1"); // BorderStyle: outline + shadow
    expect(f[16]).toBe("3"); // outline width
    const boxed = buildAss([{ index: 1, startSec: 0, endSec: 1, text: "測試" }], { width: 1920, height: 1080, style: SubtitleStyle.parse({}) });
    expect(boxed.split("\n").find((l) => l.startsWith("Style: Default"))!.split(",")[15]).toBe("3");
  });
});
