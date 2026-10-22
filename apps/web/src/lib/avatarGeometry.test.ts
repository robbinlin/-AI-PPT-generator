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
