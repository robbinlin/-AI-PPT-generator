import { AVATAR_RECT_ASPECT, avatarFrameBox, type AvatarLayout } from "@lvs/shared";

/** Fraction of frame width a rect avatar takes relative to its height (portrait 3:4). */
export const RECT_ASPECT = AVATAR_RECT_ASPECT;

export interface Box {
  /** All values are fractions of the frame (0..1). */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the avatar sits in the frame, mirroring the renderer (`overlayPosition`): a dragged
 * centre (x, y) wins and is clamped inside the frame; otherwise the anchor + margin apply.
 */
export function avatarBox(layout: AvatarLayout, ratio: number): Box {
  return avatarFrameBox(layout, ratio);
}

/** Slide image box inside the frame (scaled down and aligned when an avatar sits beside it). */
export function slideBox(layout: AvatarLayout | undefined, ratio: number): Box {
  const scale = layout?.slideScale ?? 1;
  if (scale >= 1) return { left: 0, top: 0, width: 1, height: 1 };
  const insetX = 0.04 / ratio; // renderer insets by 4% of frame height
  const left = layout?.slideAlign === "left" ? insetX : layout?.slideAlign === "right" ? 1 - scale - insetX : (1 - scale) / 2;
  return { left, top: (1 - scale) / 2, width: scale, height: scale };
}

/** New layout after dragging the avatar so its centre lands at (cx, cy) (frame fractions). */
export function moveTo(layout: AvatarLayout, ratio: number, cx: number, cy: number): AvatarLayout {
  const b = avatarBox({ ...layout, x: cx, y: cy }, ratio);
  return { ...layout, x: round3(b.left + b.width / 2), y: round3(b.top + b.height / 2) };
}

/** New layout after resizing to `size` (fraction of frame height), keeping the centre fixed. */
export function resizeTo(layout: AvatarLayout, ratio: number, size: number): AvatarLayout {
  const current = avatarBox(layout, ratio);
  const cx = current.left + current.width / 2;
  const cy = current.top + current.height / 2;
  const s = round3(clamp(size, 0.1, 1));
  return moveTo({ ...layout, size: s }, ratio, cx, cy);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
