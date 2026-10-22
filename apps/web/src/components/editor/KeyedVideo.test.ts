import { describe, expect, it } from "vitest";
import { keyGreen } from "./KeyedVideo";

describe("keyGreen", () => {
  it("drops pure green, keeps skin and clothing, softens green fringes", () => {
    const px = new Uint8ClampedArray([0, 255, 0, 255, 230, 180, 160, 255, 20, 20, 20, 255, 120, 170, 110, 255]);
    keyGreen(px);
    expect(px[3]).toBe(0); // chroma green
    expect(Array.from(px.slice(4, 8))).toEqual([230, 180, 160, 255]); // skin untouched
    expect(Array.from(px.slice(8, 12))).toEqual([20, 20, 20, 255]); // dark clothes untouched
    expect(px[15]).toBeGreaterThan(0); // fringe partially transparent
    expect(px[15]).toBeLessThan(255);
    expect(px[13]).toBe(120); // spill removed
  });
});
