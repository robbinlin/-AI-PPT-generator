import { describe, expect, it } from "vitest";
import { ProjectSettings, SubtitleStyle } from "@lvs/shared";
import { audioInputHash, avatarInputHash, outlineInputHash, renderInputHash, scriptInputHash, subtitleInputHash } from "../src/hashes.js";

const settings = ProjectSettings.parse({});

describe("input hashes", () => {
  it("outline hash ignores voice/subtitle settings but tracks audience and slide order", () => {
    const a = outlineInputHash({ slideContentHashes: ["s1", "s2"], settings });
    expect(outlineInputHash({ slideContentHashes: ["s1", "s2"], settings: { ...settings, voice: { ...settings.voice, voiceId: "X" } } })).toBe(a);
    expect(outlineInputHash({ slideContentHashes: ["s2", "s1"], settings })).not.toBe(a);
    expect(outlineInputHash({ slideContentHashes: ["s1", "s2"], settings: { ...settings, audience: "graduate" } })).not.toBe(a);
  });
  it("script hash tracks neighbours and outline", () => {
    const base = { slideContentHash: "s", outlineInputHash: "o", prevSlideContentHash: "p", nextSlideContentHash: "n", settings };
    const a = scriptInputHash(base);
    expect(scriptInputHash({ ...base })).toBe(a);
    expect(scriptInputHash({ ...base, nextSlideContentHash: "n2" })).not.toBe(a);
    expect(scriptInputHash({ ...base, outlineInputHash: "o2" })).not.toBe(a);
  });
  it("audio hash ignores subtitle colour, tracks voice speed and readings", () => {
    const a = audioInputHash({ pronunciationText: "t", voice: settings.voice, language: "zh-TW", glossary: [{ term: "x", reading: "y" }] });
    expect(audioInputHash({ pronunciationText: "t", voice: settings.voice, language: "zh-TW", glossary: [{ term: "x", reading: "y", definition: "d" }] })).toBe(a);
    expect(audioInputHash({ pronunciationText: "t", voice: { ...settings.voice, speed: 1.2 }, language: "zh-TW", glossary: [{ term: "x", reading: "y" }] })).not.toBe(a);
    expect(audioInputHash({ pronunciationText: "t", voice: settings.voice, language: "zh-TW", glossary: [{ term: "x", reading: "z" }] })).not.toBe(a);
  });
  it("subtitle/avatar/render hashes", () => {
    expect(subtitleInputHash({ audioInputHash: "a", subtitleText: "s", maxCharsPerLine: 28 })).not.toBe(
      subtitleInputHash({ audioInputHash: "a", subtitleText: "s", maxCharsPerLine: 30 }),
    );
    expect(avatarInputHash({ audioAssetId: "A", providerId: "heygen", avatarId: "v", aspectRatio: "16:9" })).not.toBe(
      avatarInputHash({ audioAssetId: "B", providerId: "heygen", avatarId: "v", aspectRatio: "16:9" }),
    );
    const style = SubtitleStyle.parse({});
    const scenes = [{ sceneId: "sc1", imageAssetId: "i", audioAssetId: "a", muted: false, tailPauseSec: 0.5 }];
    const r = renderInputHash({ scenes, subtitleStyle: style, burnSubtitles: true, transition: "fade", preset: "hd_1080p", aspectRatio: "16:9" });
    expect(renderInputHash({ scenes, subtitleStyle: { ...style, color: "#FF0000" }, burnSubtitles: true, transition: "fade", preset: "hd_1080p", aspectRatio: "16:9" })).not.toBe(r);
    expect(renderInputHash({ scenes: [...scenes].reverse(), subtitleStyle: style, burnSubtitles: true, transition: "fade", preset: "hd_1080p", aspectRatio: "16:9" })).toBe(r); // single scene
  });
});
