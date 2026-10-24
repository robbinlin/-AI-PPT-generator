import type { AvatarLayout, AvatarSettings } from "./entities.js";

/**
 * Frame geometry shared by the render worker and the editor preview, so both put the presenter
 * and the subtitles in the same place. All values are fractions of the frame (0..1).
 */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Fraction of frame height a rect avatar is wide (portrait 3:4). */
export const AVATAR_RECT_ASPECT = 0.75;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where the avatar sits (`ratio` = frame width / height): a dragged centre (x, y) wins and is
 * clamped inside the frame; otherwise the anchor + margin apply. Mirrors the renderer's overlay.
 */
export function avatarFrameBox(layout: AvatarLayout, ratio: number): FrameBox {
  const height = Math.min(1, layout.size);
  const width = Math.min(1, ((layout.shape === "circle" ? 1 : AVATAR_RECT_ASPECT) * layout.size) / ratio);
  if (layout.x !== undefined && layout.y !== undefined) {
    return { left: clamp(layout.x - width / 2, 0, 1 - width), top: clamp(layout.y - height / 2, 0, 1 - height), width, height };
  }
  const my = layout.margin;
  const mx = layout.margin / ratio;
  const [vertical, horizontal] = layout.anchor.includes("-") ? (layout.anchor.split("-") as [string, string]) : ["center", layout.anchor];
  const left = horizontal === "right" ? 1 - width - mx : mx;
  const top = vertical === "top" ? my : vertical === "bottom" ? 1 - height - my : (1 - height) / 2;
  return { left, top, width, height };
}

/** Default subtitle side margin (fraction of frame width). */
export const SUBTITLE_SIDE_MARGIN = 0.04;
/** Narrowest subtitle area worth moving to; below this the default full width is kept. */
const MIN_SUBTITLE_WIDTH = 0.4;

/**
 * Side margins that keep the subtitle line off the presenter: when the avatar reaches into the
 * subtitle band, the subtitles move to the other side of it (centred in what is left). Returns
 * null when there is no overlap, or the space beside the avatar is too narrow to be readable.
 * `fontFrac` / `marginFrac` are the subtitle font size and margin as fractions of frame height.
 */
export function subtitleSideMargins(
  layout: AvatarLayout | undefined,
  ratio: number,
  style: { position: "top" | "bottom"; fontFrac: number; marginFrac: number },
): { left: number; right: number } | null {
  if (!layout || layout.visible === false) return null;
  const box = avatarFrameBox(layout, ratio);
  // Two wrapped lines plus the box padding.
  const bandHeight = style.fontFrac * 2.8;
  const bandTop = style.position === "top" ? style.marginFrac : 1 - style.marginFrac - bandHeight;
  const bandBottom = bandTop + bandHeight;
  if (!(box.top < bandBottom && box.top + box.height > bandTop)) return null;
  const gap = 0.02;
  const onRight = box.left + box.width / 2 >= 0.5;
  const margins = onRight
    ? { left: SUBTITLE_SIDE_MARGIN, right: 1 - box.left + gap }
    : { left: box.left + box.width + gap, right: SUBTITLE_SIDE_MARGIN };
  return 1 - margins.left - margins.right >= MIN_SUBTITLE_WIDTH ? margins : null;
}

/**
 * Whether the video shows a presenter: switched on, one chosen, and not the 「只有投影片」 layout.
 * Everything that offers, prices or makes presenter clips goes by this, so nobody pays for clips
 * the render would leave out.
 */
export function avatarInVideo(avatar: Pick<AvatarSettings, "enabled" | "avatarId" | "layout">): boolean {
  return avatar.enabled && !!avatar.avatarId && avatar.layout.visible !== false;
}
