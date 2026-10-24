import { describe, expect, it } from "vitest";
import { AvatarLayout } from "./entities.js";
import { avatarFrameBox, subtitleSideMargins } from "./layout.js";

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
