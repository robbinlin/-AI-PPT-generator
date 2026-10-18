/** Slide art for the mock API: drawn on a canvas at runtime, with an SVG fallback (e.g. jsdom). */

export interface SlideArtSpec {
  pageNumber: number;
  title: string;
  bullets: string[];
  hue: number;
  width: number;
  height: number;
}

export type SlideRenderer = (spec: SlideArtSpec) => string;

function canCanvas(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  // jsdom implements <canvas> without a 2D context and logs an error when asked for one.
  return !/jsdom/i.test(navigator.userAgent);
}

export const renderSlideArt: SlideRenderer = (spec) => {
  if (canCanvas()) {
    const url = renderWithCanvas(spec);
    if (url) return url;
  }
  return renderSvg(spec);
};

function renderWithCanvas(spec: SlideArtSpec): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width: w, height: h } = spec;

  ctx.fillStyle = `hsl(${spec.hue} 45% 22%)`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `hsl(${spec.hue} 55% 32%)`;
  ctx.fillRect(0, 0, w, h * 0.012);
  ctx.fillRect(w * 0.06, h * 0.3, w * 0.12, h * 0.008);

  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.font = `700 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(String(spec.pageNumber), w * 0.95, h * 0.94);

  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(h * 0.075)}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
  ctx.fillText(spec.title, w * 0.06, h * 0.24, w * 0.86);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `400 ${Math.round(h * 0.045)}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
  spec.bullets.forEach((b, i) => {
    ctx.fillText(`•  ${b}`, w * 0.07, h * (0.42 + i * 0.09), w * 0.6);
  });

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = `500 ${Math.round(h * 0.032)}px system-ui, sans-serif`;
  ctx.fillText(`P${spec.pageNumber}`, w * 0.06, h * 0.93);
  return canvas.toDataURL("image/png");
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export function renderSvg(spec: SlideArtSpec): string {
  const { width: w, height: h } = spec;
  const bullets = spec.bullets
    .map(
      (b, i) =>
        `<text x="${w * 0.07}" y="${h * (0.42 + i * 0.09)}" font-size="${h * 0.045}" fill="rgba(255,255,255,0.85)">• ${esc(b)}</text>`,
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, sans-serif">` +
    `<rect width="${w}" height="${h}" fill="hsl(${spec.hue},45%,22%)"/>` +
    `<text x="${w * 0.95}" y="${h * 0.94}" text-anchor="end" font-size="${h * 0.42}" font-weight="700" fill="rgba(255,255,255,0.1)">${spec.pageNumber}</text>` +
    `<text x="${w * 0.06}" y="${h * 0.24}" font-size="${h * 0.075}" font-weight="700" fill="#fff">${esc(spec.title)}</text>` +
    bullets +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Simple head-and-shoulders silhouette used as the mock avatar "video". */
export function avatarPlaceholderSvg(hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="hsl(${hue},30%,70%)"/>` +
    `<circle cx="50" cy="40" r="18" fill="hsl(${hue},25%,35%)"/>` +
    `<path d="M14 100c4-22 18-32 36-32s32 10 36 32z" fill="hsl(${hue},25%,35%)"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
