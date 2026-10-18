export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1, 1 = opaque */
  a: number;
}

/** Parses `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` (leading `#` or `0x` optional). */
export function parseHexColor(input: string): Rgba {
  let hex = input.trim();
  if (hex.startsWith("#")) hex = hex.slice(1);
  else if (/^0x/i.test(hex)) hex = hex.slice(2);
  if (!/^[0-9a-f]+$/i.test(hex) || ![3, 4, 6, 8].includes(hex.length)) {
    throw new Error(`invalid colour "${input}" (expected #RRGGBB)`);
  }
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

const h2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();

/** ffmpeg colour syntax `0xRRGGBB` (safe inside a filtergraph). */
export function ffmpegColor(input: string): string {
  const { r, g, b } = parseHexColor(input);
  return `0x${h2(r)}${h2(g)}${h2(b)}`;
}

/**
 * ASS colour `&HAABBGGRR`. ASS alpha is inverted: 00 = opaque, FF = transparent.
 * `opacity` multiplies any alpha present in the hex string.
 */
export function assColor(input: string, opacity = 1): string {
  const { r, g, b, a } = parseHexColor(input);
  const alpha = 255 * (1 - Math.max(0, Math.min(1, a * opacity)));
  return `&H${h2(alpha)}${h2(b)}${h2(g)}${h2(r)}`;
}
