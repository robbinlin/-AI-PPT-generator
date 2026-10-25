import { describe, expect, it } from "vitest";
import { AvatarLayout } from "@lvs/shared";
import { avatarBox, moveTo, resizeTo, slideBox } from "./avatarGeometry";
import { LAYOUT_PRESETS, matchLayoutPreset, matchSubtitlePreset, SUBTITLE_PRESETS } from "./studioPresets";
import { SubtitleStyle } from "@lvs/shared";

const R = 16 / 9;
const base = AvatarLayout.parse({});

describe("avatarBox", () => {
  it("anchors like the renderer and honours a dragged centre, clamped inside", () => {
    const b = avatarBox(base, R);
    expect(b.top + b.height).toBeCloseTo(1 - base.margin);
    expect(b.left + b.width).toBeCloseTo(1 - base.margin / R);
    const free = avatarBox({ ...base, x: 0.99, y: 0.01 }, R);
    expect(free.left + free.width).toBeCloseTo(1);
    expect(free.top).toBe(0);
  });
  it("moves and resizes around the centre", () => {
    const m = moveTo(base, R, 0.5, 0.5);
    expect([m.x, m.y]).toEqual([0.5, 0.5]);
    const r = resizeTo(m, R, 0.5);
    expect(r.size).toBe(0.5);
    expect([r.x, r.y]).toEqual([0.5, 0.5]);
  });
  it("scales and aligns the slide like the renderer", () => {
    expect(slideBox({ ...base, slideScale: 0.75, slideAlign: "left" }, R)).toMatchObject({ width: 0.75, top: 0.125 });
    expect(slideBox({ ...base, slideScale: 1 }, R)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });
});

describe("presets", () => {
  it("recognises the layout each preset produces", () => {
    for (const p of LAYOUT_PRESETS) {
      const l = { ...base, ...p.layout } as AvatarLayout;
      expect(matchLayoutPreset(l)).toBe(p.id);
    }
  });
  it("recognises subtitle presets", () => {
    for (const p of SUBTITLE_PRESETS) expect(matchSubtitlePreset(SubtitleStyle.parse({ ...p.style }))).toBe(p.id);
  });
});

describe("side presets", () => {
  it("leave room for the presenter: the slide is never shrunk or covered", () => {
    for (const p of LAYOUT_PRESETS.filter((x) => x.layout.visible !== false)) {
      const layout = AvatarLayout.parse({ ...base, ...p.layout });
      const slide = slideBox(layout, R);
      expect(slide.width).toBe(layout.slideScale);
      if (layout.slideScale < 1) {
        const av = avatarBox(layout, R);
        const overlap = Math.min(slide.left + slide.width, av.left + av.width) - Math.max(slide.left, av.left);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it("still name projects saved with the earlier side presets", () => {
    const old = AvatarLayout.parse({ shape: "rect", anchor: "bottom-right", size: 0.86, margin: 0, slideScale: 0.74, slideAlign: "left", x: 0.86, y: 0.57 });
    expect(matchLayoutPreset(old)).toBe("presenter-right");
    // ... and the preview shows the slide shrunk off the presenter, like the video.
    expect(slideBox(old, R).width).toBeLessThan(0.74);
  });
});