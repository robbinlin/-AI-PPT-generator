import type { AvatarLayout, SubtitleStyle } from "@lvs/shared";

export interface LayoutPreset {
  id: string;
  label: string;
  layout: Partial<AvatarLayout>;
}

/**
 * One-click frame layouts (VoAI-style). Each preset sets every positional field so applying one
 * fully replaces a dragged position; sizes are fractions of frame height.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: "corner-br",
    label: "右下圓框",
    layout: { visible: true, shape: "circle", anchor: "bottom-right", size: 0.28, margin: 0.03, slideScale: 1, slideAlign: "center", x: undefined, y: undefined },
  },
  {
    id: "corner-tl",
    label: "左上圓框",
    layout: { visible: true, shape: "circle", anchor: "top-left", size: 0.28, margin: 0.03, slideScale: 1, slideAlign: "center", x: undefined, y: undefined },
  },
  {
    id: "presenter-right",
    label: "人像在右",
    layout: { visible: true, shape: "rect", anchor: "bottom-right", size: 0.86, margin: 0, slideScale: 0.74, slideAlign: "left", x: 0.86, y: 0.57 },
  },
  {
    id: "presenter-left",
    label: "人像在左",
    layout: { visible: true, shape: "rect", anchor: "bottom-left", size: 0.86, margin: 0, slideScale: 0.74, slideAlign: "right", x: 0.14, y: 0.57 },
  },
  {
    id: "bust-br",
    label: "半身右下",
    layout: { visible: true, shape: "rect", anchor: "bottom-right", size: 0.5, margin: 0, slideScale: 1, slideAlign: "center", x: undefined, y: undefined },
  },
  {
    id: "hidden",
    label: "只有投影片",
    layout: { visible: false, slideScale: 1, slideAlign: "center" },
  },
];

/** The preset a layout currently matches (ignores fine size tweaks within a few percent). */
export function matchLayoutPreset(layout: AvatarLayout): string | undefined {
  const near = (a: number | undefined, b: number | undefined, eps: number) =>
    a === undefined || b === undefined ? a === b : Math.abs(a - b) <= eps;
  return LAYOUT_PRESETS.find((p) => {
    const l = p.layout;
    if (l.visible === false) return !layout.visible;
    return (
      layout.visible &&
      l.shape === layout.shape &&
      near(l.slideScale, layout.slideScale, 0.02) &&
      l.slideAlign === layout.slideAlign &&
      (l.x === undefined ? layout.x === undefined && l.anchor === layout.anchor : near(l.x, layout.x, 0.06) && near(l.y, layout.y, 0.08))
    );
  })?.id;
}

export interface SubtitlePreset {
  id: string;
  label: string;
  style: Partial<SubtitleStyle>;
}

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  { id: "box", label: "黑底白字", style: { color: "#FFFFFF", backgroundColor: "#000000", backgroundOpacity: 0.6, outlineWidthPx: 0, bold: false } },
  { id: "box-light", label: "淡底白字", style: { color: "#FFFFFF", backgroundColor: "#000000", backgroundOpacity: 0.3, outlineWidthPx: 0, bold: false } },
  { id: "outline", label: "白字黑邊", style: { color: "#FFFFFF", backgroundOpacity: 0, outlineColor: "#000000", outlineWidthPx: 3, bold: true } },
  { id: "yellow", label: "黃字黑邊", style: { color: "#FFD60A", backgroundOpacity: 0, outlineColor: "#000000", outlineWidthPx: 3, bold: true } },
  { id: "paper", label: "白底黑字", style: { color: "#111111", backgroundColor: "#FFFFFF", backgroundOpacity: 0.9, outlineWidthPx: 0, bold: false } },
  { id: "brand", label: "藍底白字", style: { color: "#FFFFFF", backgroundColor: "#1D4ED8", backgroundOpacity: 0.85, outlineWidthPx: 0, bold: true } },
];

export function matchSubtitlePreset(style: SubtitleStyle): string | undefined {
  return SUBTITLE_PRESETS.find((p) =>
    Object.entries(p.style).every(([k, v]) => {
      const cur = (style as Record<string, unknown>)[k];
      if (k === "backgroundColor" && style.backgroundOpacity === 0) return true;
      return typeof v === "string" && typeof cur === "string" ? v.toLowerCase() === cur.toLowerCase() : v === cur;
    }),
  )?.id;
}

/** CSS that approximates the burned-in ASS style (box or outline) for previews and preset cards. */
export function subtitleCss(style: SubtitleStyle, scale: (px: number) => string): Record<string, string> {
  const css: Record<string, string> = {
    color: style.color,
    fontWeight: style.bold ? "700" : "500",
    fontSize: scale(style.fontSizePx),
  };
  if (style.backgroundOpacity > 0) {
    css.backgroundColor = hexToRgba(style.backgroundColor, style.backgroundOpacity);
  } else if ((style.outlineWidthPx ?? 0) > 0) {
    const w = scale(style.outlineWidthPx);
    const c = style.outlineColor ?? "#000000";
    css.textShadow = [`${w} 0`, `-${w} 0`, `0 ${w}`, `0 -${w}`, `${w} ${w}`, `-${w} -${w}`, `${w} -${w}`, `-${w} ${w}`].map((o) => `${o} 0 ${c}`).join(",");
  }
  return css;
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
