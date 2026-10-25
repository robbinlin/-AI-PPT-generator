import { describe, expect, it } from "vitest";
import { AvatarLayout } from "./entities.js";
import { avatarFrameBox, avatarInVideo, fittedSlideScale, SLIDE_INSET, subtitleSideMargins } from "./layout.js";

const RATIO = 16 / 9;
const style = { position: "bottom" as const, fontFrac: 44 / 1080, marginPx: 0, marginFrac: 48 / 1080 };

describe("subtitleSideMargins", () => {
  it("moves the subtitles left of a bottom-right presenter, centred in what is left", () => {
    const layout = AvatarLayout.parse({ anchor: "bottom-right", size: 0.6, margin: 0 });
    const box = avatarFrameBox(layout, RATIO);
    const m = subtitleSideMargins(layout, RATIO, style)!;
    expect(m).not.toBeNull();
    expect(m.left).toBeCloseTo(0.04);
    expect(1 - m.right).toBeLessThan(box.left); // the band ends before the presenter starts
  });

  it("keeps full width when the presenter sits above the subtitle line", () => {
    const layout = AvatarLayout.parse({ anchor: "top-right", size: 0.3, margin: 0.03 });
    expect(subtitleSideMargins(layout, RATIO, style)).toBeNull();
  });

  it("keeps full width when the space beside a huge presenter would be unreadable", () => {
    const layout = AvatarLayout.parse({ anchor: "bottom-right", size: 1, margin: 0, x: 0.5, y: 0.5 });
    expect(subtitleSideMargins(layout, 9 / 16, style)).toBeNull();
  });

  it("does nothing for a hidden presenter", () => {
    const layout = AvatarLayout.parse({ anchor: "bottom-left", size: 0.6, visible: false });
    expect(subtitleSideMargins(layout, RATIO, style)).toBeNull();
  });
});

describe("fittedSlideScale", () => {
  // The 「人像在右」 layout saved before the fit: slide 74%, presenter 86% tall at the right edge.
  const old = AvatarLayout.parse({ shape: "rect", anchor: "bottom-right", size: 0.86, margin: 0, slideScale: 0.74, slideAlign: "left", x: 0.86, y: 0.57 });

  it("shrinks a side slide so it ends where the presenter begins", () => {
    const scale = fittedSlideScale(old, RATIO);
    const box = avatarFrameBox(old, RATIO);
    expect(scale).toBeLessThan(0.74);
    expect(SLIDE_INSET / RATIO + scale).toBeLessThanOrEqual(box.left);
    // Mirrored: presenter on the left, slide on the right.
    const mirrored = AvatarLayout.parse({ ...old, anchor: "bottom-left", slideAlign: "right", x: 0.14 });
    expect(fittedSlideScale(mirrored, RATIO)).toBeCloseTo(scale, 2);
  });

  it("leaves slides alone when nothing is in the way", () => {
    expect(fittedSlideScale(AvatarLayout.parse({ ...old, size: 0.4 }), RATIO)).toBe(0.74); // room enough
    expect(fittedSlideScale(AvatarLayout.parse({ ...old, slideAlign: "right" }), RATIO)).toBe(0.74); // same side
    expect(fittedSlideScale(AvatarLayout.parse({ ...old, slideAlign: "center" }), RATIO)).toBe(0.74);
    expect(fittedSlideScale(AvatarLayout.parse({ ...old, visible: false }), RATIO)).toBe(0.74);
    expect(fittedSlideScale(AvatarLayout.parse({ shape: "circle", slideScale: 1 }), RATIO)).toBe(1);
    expect(fittedSlideScale(undefined, RATIO)).toBe(1);
  });

  it("never shrinks below half the frame", () => {
    expect(fittedSlideScale(AvatarLayout.parse({ ...old, size: 1, x: 0.7 }), RATIO)).toBe(0.5);
  });
});

describe("avatarInVideo", () => {
  const layout = { visible: true } as never;
  it("needs the presenter on, chosen and shown", () => {
    expect(avatarInVideo({ enabled: true, avatarId: "a", layout })).toBe(true);
    expect(avatarInVideo({ enabled: false, avatarId: "a", layout })).toBe(false);
    expect(avatarInVideo({ enabled: true, avatarId: undefined, layout } as never)).toBe(false);
    expect(avatarInVideo({ enabled: true, avatarId: "a", layout: { visible: false } as never })).toBe(false);
  });
});
