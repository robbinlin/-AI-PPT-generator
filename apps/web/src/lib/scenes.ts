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
  const sentence = text.trim().split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+|\n+/)[0] ?? "";
  const body = sentence.replace(/[，。！？、；：,.!?;:]+$/u, "");
  // Wrap by width (a CJK character is one unit, a Latin letter about half) and never inside an
  // English word, as the export does.
  const tokens = body.match(/[A-Za-z0-9₀-₉⁰-⁹'’.\-]+\s*|\s+|./gu) ?? [];
  const width = (s: string) => Array.from(s).reduce((w, ch) => w + (/[⺀-￯]/u.test(ch) ? 1 : 0.55), 0);
  const lines: string[] = [""];
  for (const tok of tokens) {
    const line = lines[lines.length - 1]!;
    if (line && width(line + tok.trimEnd()) > maxCharsPerLine) {
      if (lines.length === 2) {
        lines[1] = `${line.trimEnd()}…`;
        break;
      }
      lines.push(tok.trimStart());
    } else {
      lines[lines.length - 1] = line + tok;
    }
  }
  return lines.map((l) => l.trimEnd()).join("\n");
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
