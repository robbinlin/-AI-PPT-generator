import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { describe, expect, it } from "vitest";
import { ProjectSettings } from "@lvs/shared";
import type { SceneRow, SlideRow } from "../src/db/schema.js";
import { matchScenes, slideContentHash } from "../src/jobs/handlers/parse-document.js";
import { audioInputHash, effectiveStatus, outlineInputHash, renderInputHash, scriptInputHash, selectScenesToProcess } from "../src/jobs/hashes.js";
import { withEffectiveStatuses } from "../src/services/projects.js";
import { speechTargets } from "../src/jobs/plan.js";
import { HttpError } from "@lvs/providers";
import { providerErrorMessage } from "../src/errors.js";
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

describe("loadConfig secrets", () => {
  it("generates secrets once and reuses them on the next start", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvs-cfg-"));
    // Empty strings mirror an untouched copy of .env.example and must behave like unset.
    const overrides = { PGLITE_DIR: join(dir, "pglite"), ASSET_URL_SECRET: "", PROVIDER_KEY_ENCRYPTION_KEY: "", LOG_LEVEL: "silent" as const };
    const a = loadConfig(overrides);
    const b = loadConfig(overrides);
    expect(a.providerKeyEncryptionKey.length).toBe(32);
    expect(b.providerKeyEncryptionKey.equals(a.providerKeyEncryptionKey)).toBe(true);
    expect(b.assetUrlSecret).toBe(a.assetUrlSecret);
    expect(a.warnings.join(" ")).not.toMatch(/unreadable after restart/);
    const onDisk = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
    expect(Buffer.from(onDisk.providerKeyEncryptionKey, "base64").equals(a.providerKeyEncryptionKey)).toBe(true);
    // An explicit env value still wins over the persisted one.
    const c = loadConfig({ ...overrides, PROVIDER_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
    expect(c.providerKeyEncryptionKey.equals(Buffer.alloc(32, 9))).toBe(true);
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

describe("providerErrorMessage", () => {
  it("unwraps vendor error envelopes", () => {
    const el = new HttpError(401, "https://api.elevenlabs.io/v1/x", JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    expect(providerErrorMessage(el)).toBe("HTTP 401 invalid_api_key: Invalid API key");
    const g = new HttpError(429, "https://g/x?key=k", JSON.stringify({ error: { message: "quota exceeded" } }));
    expect(providerErrorMessage(g)).toBe("HTTP 429 quota exceeded");
    expect(providerErrorMessage(new HttpError(502, "u", "<html>bad gateway</html>"))).toBe("HTTP 502 <html>bad gateway</html>");
    expect(providerErrorMessage(new Error("boom"))).toBe("boom");
  });
});

describe("withEffectiveStatuses", () => {
  it("compares a script with its visible neighbours, like generate_script writes it", () => {
    const settings = ProjectSettings.parse({});
    const slides = [0, 1, 2].map((i) => ({ id: `s${i}`, index: i, contentHash: `h${i}`, hidden: i === 1 }) as never as import("@lvs/shared").Slide);
    const outlineHash = outlineInputHash(slides, settings);
    // Page 3 was written next to page 1 (page 2 is hidden).
    const hash = scriptInputHash({ slide: slides[2]!, prev: slides[0], next: undefined, outlineInputHash: outlineHash, settings });
    const scene = { id: "c2", slideId: "s2", index: 2, script: { status: "ready", inputHash: hash }, audio: { status: "missing" }, subtitle: { status: "missing" }, avatar: { status: "missing" } } as never as import("@lvs/shared").Scene;
    const others = [0, 1].map((i) => ({ id: `c${i}`, slideId: `s${i}`, index: i, script: { status: "missing" }, audio: { status: "missing" }, subtitle: { status: "missing" }, avatar: { status: "missing" } }) as never as import("@lvs/shared").Scene);
    const scripts = { c2: { source: "ai", pronunciationText: "", subtitleText: "" } } as never;
    const out = withEffectiveStatuses([...others, scene], new Map(slides.map((s) => [s.id, s])), scripts, undefined, settings);
    expect(out[2]!.script.status).toBe("ready");
  });
});

describe("retried forced jobs", () => {
  it("skip the pages the same job already finished", () => {
    const scene = (id: string, jobId: string) => ({ id, slideId: "a", index: 0, muted: false, audio: { status: "ready", jobId }, script: { status: "ready" }, avatar: { status: "missing" }, subtitle: { status: "missing" } });
    const detail = { slides: [{ id: "a", hidden: false }], scenes: [scene("x", "J"), scene("y", "K")], scripts: { x: {}, y: {} } } as never;
    expect(speechTargets(detail, { force: true, jobId: "J" }).map((s) => s.id)).toEqual(["y"]);
    expect(speechTargets(detail, { force: true }).map((s) => s.id)).toEqual(["x", "y"]);
  });
});

describe("renderInputHash", () => {
  it("changes when a page's slide content changes (deck replaced with an edited slide)", () => {
    const settings = ProjectSettings.parse({});
    const scene = { id: "c1", slideId: "s1", muted: false, tailPauseSec: 0.5, audio: { status: "ready", assetId: "a" }, avatar: { status: "missing" }, subtitle: { status: "ready", assetId: "srt" } } as never as import("@lvs/shared").Scene;
    const hash = (contentHash: string) =>
      renderInputHash({ scenesInOrder: [scene], settings, preset: "hd_1080p", burnSubtitles: true, slidesById: new Map([["s1", { id: "s1", contentHash } as never]]) });
    expect(hash("v1")).toBe(hash("v1"));
    expect(hash("v1")).not.toBe(hash("v2"));
  });
});
