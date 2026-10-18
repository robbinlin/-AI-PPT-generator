import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./hash.js";
import { ParserManifest, ProjectSettings, RenderSpec } from "./index.js";

describe("contentHash", () => {
  it("is independent of key order and undefined fields", () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(contentHash({ b: [1, { c: 2 }], a: 1 }));
  });
  it("canonicalJson sorts nested keys", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 0 })).toBe('{"a":0,"z":{"x":2,"y":1}}');
  });
});

describe("schemas", () => {
  it("ProjectSettings fills defaults", () => {
    const s = ProjectSettings.parse({});
    expect(s.language).toBe("zh-TW");
    expect(s.voice.providerId).toBe("gemini");
    expect(s.avatar.layout.anchor).toBe("bottom-right");
  });
  it("ParserManifest validates a minimal manifest", () => {
    const m = ParserManifest.parse({
      schemaVersion: 1,
      sourceKind: "pdf",
      pageCount: 1,
      pages: [{ pageNumber: 1, imagePath: "pages/001.png", thumbnailPath: "thumbs/001.png", contentPath: "pages/001.json", imageWidthPx: 1920, imageHeightPx: 1080 }],
    });
    expect(m.meta.warnings).toEqual([]);
  });
  it("RenderSpec requires at least one scene", () => {
    expect(() => RenderSpec.parse({ schemaVersion: 1, width: 1920, height: 1080, scenes: [], subtitleStyle: {}, outputs: { mp4Path: "x.mp4" } })).toThrow();
  });
});
