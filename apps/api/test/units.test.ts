import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProjectSettings } from "@lvs/shared";
import type { SceneRow, SlideRow } from "../src/db/schema.js";
import { matchScenes, slideContentHash } from "../src/jobs/handlers/parse-document.js";
import { audioInputHash, effectiveStatus, outlineInputHash, selectScenesToProcess } from "../src/jobs/hashes.js";
import { KeyCrypto } from "../src/services/providers.js";
import { estimateSpeakingSeconds, fallbackDeriveTexts } from "../src/services/scripts.js";
import { AssetUrlSigner } from "../src/storage/signing.js";
import { sniffSourceKind } from "../src/util/magic.js";

describe("AssetUrlSigner", () => {
  const signer = new AssetUrlSigner("secret", "http://x/");
  it("round-trips and rejects tampering / expiry", () => {
    const { sig, exp, url } = signer.sign("asset-1", 60);
    expect(url).toBe(`http://x/assets/asset-1?sig=${sig}&exp=${exp}`);
    expect(signer.verify("asset-1", sig, exp)).toBe(true);
    expect(signer.verify("asset-2", sig, exp)).toBe(false);
    expect(signer.verify("asset-1", sig + "a", exp)).toBe(false);
    expect(signer.verify("asset-1", sig, exp, (exp + 1) * 1000)).toBe(false);
    expect(signer.verify("asset-1", undefined, exp)).toBe(false);
  });
});

describe("sniffSourceKind", () => {
  it("detects pdf / ppt / pptx and rejects others", () => {
    expect(sniffSourceKind(Buffer.from("%PDF-1.7 ..."), "a.pdf")).toBe("pdf");
    expect(sniffSourceKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "a.ppt")).toBe("ppt");
    expect(sniffSourceKind(Buffer.from("PK\x03\x04....[Content_Types].xml....ppt/slides/slide1.xml"), "a.pptx")).toBe("pptx");
    expect(sniffSourceKind(Buffer.from("PK\x03\x04....[Content_Types].xml....word/document.xml"), "a.docx")).toBeNull();
    expect(sniffSourceKind(Buffer.from("PK\x03\x04....[Content_Types].xml"), "deck.pptx")).toBe("pptx");
    expect(sniffSourceKind(Buffer.from("hello"), "a.txt")).toBeNull();
  });
});

describe("KeyCrypto", () => {
  it("encrypts and decrypts with AES-256-GCM", () => {
    const c = new KeyCrypto(Buffer.alloc(32, 1));
    const blob = c.encrypt("sk-live-abc");
    expect(blob).not.toContain("sk-live");
    expect(c.decrypt(blob)).toBe("sk-live-abc");
    expect(() => new KeyCrypto(Buffer.alloc(32, 2)).decrypt(blob)).toThrow();
  });
});

describe("scripts", () => {
  it("fallbackDeriveTexts normalises whitespace", () => {
    expect(fallbackDeriveTexts("a  b\r\n\r\n\r\nc", "zh-TW")).toEqual({ pronunciationText: "a b\n\nc", subtitleText: "a b\n\nc" });
  });
  it("estimateSpeakingSeconds handles zh and en", () => {
    expect(estimateSpeakingSeconds("這是一段四十二個字的中文測試文字", "zh-TW")).toBeCloseTo(16 / 4.2, 1);
    expect(estimateSpeakingSeconds("one two three four five", "en")).toBeCloseTo(2, 1);
  });
});

describe("hashes", () => {
  const settings = ProjectSettings.parse({});
  it("audio hash changes with voice but not with subtitle style", () => {
    const a = audioInputHash({ pronunciationText: "hi", settings });
    const b = audioInputHash({ pronunciationText: "hi", settings: { ...settings, voice: { ...settings.voice, speed: 1.2 } } });
    const c = audioInputHash({ pronunciationText: "hi", settings: { ...settings, subtitles: { ...settings.subtitles, style: { ...settings.subtitles.style, color: "#f00" } } } });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
  it("outline hash ignores hidden slides", () => {
    const mk = (hash: string, hidden = false) => ({ hidden, contentHash: hash }) as never;
    expect(outlineInputHash([mk("1"), mk("2", true)], settings)).toBe(outlineInputHash([mk("1")], settings));
  });
  it("effectiveStatus flags stale", () => {
    expect(effectiveStatus({ status: "ready", inputHash: "a" }, "a")).toBe("ready");
    expect(effectiveStatus({ status: "ready", inputHash: "a" }, "b")).toBe("stale");
    expect(effectiveStatus({ status: "missing" }, "b")).toBe("missing");
  });
  it("selectScenesToProcess", () => {
    const scenes = [
      { id: "1", s: "ready" },
      { id: "2", s: "stale" },
      { id: "3", s: "missing" },
    ] as const;
    const pick = (force: boolean, ids?: string[]) => selectScenesToProcess([...scenes], ids, force, (x) => x.s).map((x) => x.id);
    expect(pick(false)).toEqual(["2", "3"]);
    expect(pick(true)).toEqual(["1", "2", "3"]);
    expect(pick(false, ["1", "2"])).toEqual(["2"]);
  });
});

describe("matchScenes", () => {
  const slide = (page: number, text: string): SlideRow =>
    ({ id: randomUUID(), pageNumber: page, contentHash: slideContentHash(text, undefined) }) as SlideRow;
  const scene = (): SceneRow => ({ id: randomUUID(), script: { status: "ready" } }) as SceneRow;
  it("matches by hash first, then by page number", () => {
    const oldA = { scene: scene(), slide: slide(1, "A") };
    const oldB = { scene: scene(), slide: slide(2, "B") };
    const oldC = { scene: scene(), slide: slide(3, "C") };
    const newSlides = [slide(1, "A-changed"), slide(2, "B"), slide(3, "C"), slide(4, "D")];
    const m = matchScenes(newSlides, [oldA, oldB, oldC]);
    expect(m.get(newSlides[0]!.id)).toEqual({ scene: oldA.scene, kind: "changed" }); // page-number fallback
    expect(m.get(newSlides[1]!.id)).toEqual({ scene: oldB.scene, kind: "same" });
    expect(m.get(newSlides[2]!.id)).toEqual({ scene: oldC.scene, kind: "same" });
    expect(m.get(newSlides[3]!.id)).toBeUndefined();

    // Hash match wins over page number even when pages move.
    const moved = [slide(1, "B"), slide(2, "A")];
    const m2 = matchScenes(moved, [oldA, oldB]);
    expect(m2.get(moved[0]!.id)).toEqual({ scene: oldB.scene, kind: "same" });
    expect(m2.get(moved[1]!.id)).toEqual({ scene: oldA.scene, kind: "same" });
  });
});
