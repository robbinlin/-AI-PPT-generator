import type { Asset, AvatarLayout, Language, Project, Scene, Slide } from "@lvs/shared";

/** Narration length of the visible (non-hidden) scenes, including each scene's tail pause. */
export function computeTotalDuration(slides: readonly Slide[], scenes: readonly Scene[]): number {
  const hidden = new Set(slides.filter((s) => s.hidden).map((s) => s.id));
  let total = 0;
  for (const scene of scenes) {
    if (hidden.has(scene.slideId) || scene.durationSec === undefined) continue;
    total += scene.durationSec + scene.tailPauseSec;
  }
  return Math.round(total * 100) / 100;
}

/** Characters (CJK) or words (Latin) per second at speed 1.0. */
const RATE_CJK = 4.5;
const RATE_WORDS = 2.6;
/** CJK Unified Ideographs (incl. Ext. A) and compatibility ideographs. */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;

/** Rough speaking time before audio exists. Mixed text counts CJK chars and Latin words separately. */
export function estimateSpeechSeconds(text: string, _language: Language, speed = 1): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const words = (text.replace(CJK_RE, " ").match(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g) ?? []).length;
  const seconds = cjk / RATE_CJK + words / RATE_WORDS;
  return Math.round(seconds / Math.max(0.1, speed));
}

export function countChars(text: string): number {
  return Array.from(text).length;
}

export function firstLine(text: string | undefined): string {
  if (!text) return "";
  return text.trim().split(/\n/)[0] ?? "";
}

export function sortByIndex<T extends { index: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.index - b.index);
}

/** Layout the avatar is drawn with for a scene: the scene override, else the project default. */
export function effectiveAvatarLayout(project: Project, scene: Scene | undefined): AvatarLayout {
  return scene?.avatarLayout ?? project.settings.avatar.layout;
}

/** First subtitle "cue" for the preview strip: the first sentence, wrapped to maxCharsPerLine. */
export function firstSubtitleCue(text: string | undefined, maxCharsPerLine: number): string {
  if (!text) return "";
  const sentence = text.trim().split(/(?<=[。！？!?；;])\s*|\n+/)[0] ?? "";
  const chars = Array.from(sentence.replace(/[，。！？、；：,.!?;:]+$/u, ""));
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < 2; i += maxCharsPerLine) {
    lines.push(chars.slice(i, i + maxCharsPerLine).join(""));
  }
  return lines.join("\n");
}

/** Latest project-level asset of a kind that no scene references (e.g. the rendered SRT). */
export function latestProjectAsset(
  assets: Record<string, Asset>,
  scenes: readonly Scene[],
  kind: Asset["kind"],
): Asset | undefined {
  const sceneOwned = new Set<string>();
  for (const s of scenes) {
    for (const st of [s.audio, s.avatar, s.subtitle]) if (st.assetId) sceneOwned.add(st.assetId);
  }
  return Object.values(assets)
    .filter((a) => a.kind === kind && !sceneOwned.has(a.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
