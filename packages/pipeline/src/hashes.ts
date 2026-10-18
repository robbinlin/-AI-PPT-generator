import type { AspectRatio, AvatarLayout, GlossaryEntry, ProjectSettings, SubtitleStyle, Transition } from "@lvs/shared";
import { contentHash } from "@lvs/shared";

/**
 * Input hashes, one per derived asset, exactly as documented in
 * docs/ARCHITECTURE.md ("Input hashes"). Equal hash => the existing asset can be reused.
 */

/** The subset of settings that changes what the script writer produces. */
export function scriptSettingsSubset(settings: ProjectSettings) {
  return {
    language: settings.language,
    audience: settings.audience,
    audienceNote: settings.audienceNote ?? null,
    mode: settings.mode,
    contentBoundary: settings.contentBoundary,
    targetDurationSec: settings.targetDurationSec ?? null,
    styleNote: settings.styleNote ?? null,
    llmProviderId: settings.llmProviderId,
  };
}

export function outlineInputHash(input: { slideContentHashes: string[]; settings: ProjectSettings }): string {
  return contentHash({ kind: "outline", slides: input.slideContentHashes, settings: scriptSettingsSubset(input.settings) });
}

export function scriptInputHash(input: {
  slideContentHash: string;
  outlineInputHash: string;
  prevSlideContentHash?: string;
  nextSlideContentHash?: string;
  settings: ProjectSettings;
}): string {
  return contentHash({
    kind: "script",
    slide: input.slideContentHash,
    outline: input.outlineInputHash,
    prev: input.prevSlideContentHash ?? null,
    next: input.nextSlideContentHash ?? null,
    settings: scriptSettingsSubset(input.settings),
  });
}

export function audioInputHash(input: {
  pronunciationText: string;
  voice: ProjectSettings["voice"];
  glossary?: GlossaryEntry[];
  language: ProjectSettings["language"];
}): string {
  const readings = (input.glossary ?? [])
    .filter((g) => g.reading)
    .map((g) => ({ term: g.term, reading: g.reading }))
    .sort((a, b) => a.term.localeCompare(b.term));
  return contentHash({
    kind: "audio",
    text: input.pronunciationText,
    voice: {
      providerId: input.voice.providerId,
      voiceId: input.voice.voiceId,
      speed: input.voice.speed,
      sentencePauseSec: input.voice.sentencePauseSec,
    },
    readings,
    language: input.language,
  });
}

export function subtitleInputHash(input: { audioInputHash: string; subtitleText: string; maxCharsPerLine: number }): string {
  return contentHash({ kind: "subtitle", audio: input.audioInputHash, text: input.subtitleText, maxCharsPerLine: input.maxCharsPerLine });
}

export function avatarInputHash(input: { audioAssetId: string; providerId: string; avatarId: string; aspectRatio: AspectRatio }): string {
  return contentHash({ kind: "avatar", audio: input.audioAssetId, providerId: input.providerId, avatarId: input.avatarId, aspectRatio: input.aspectRatio });
}

export interface RenderSceneInputs {
  sceneId: string;
  imageAssetId?: string;
  audioAssetId?: string;
  avatarVideoAssetId?: string;
  subtitleAssetId?: string;
  muted: boolean;
  tailPauseSec: number;
  avatarLayout?: AvatarLayout;
  transitionIn?: Transition;
}

export function renderInputHash(input: {
  scenes: RenderSceneInputs[];
  subtitleStyle: SubtitleStyle;
  burnSubtitles: boolean;
  transition: Transition;
  preset: string;
  aspectRatio: AspectRatio;
}): string {
  return contentHash({
    kind: "render",
    scenes: input.scenes.map((s) => ({
      id: s.sceneId,
      image: s.imageAssetId ?? null,
      audio: s.audioAssetId ?? null,
      avatar: s.avatarVideoAssetId ?? null,
      subtitle: s.subtitleAssetId ?? null,
      muted: s.muted,
      tail: s.tailPauseSec,
      layout: s.avatarLayout ?? null,
      transitionIn: s.transitionIn ?? null,
    })),
    subtitleStyle: input.subtitleStyle,
    burnSubtitles: input.burnSubtitles,
    transition: input.transition,
    preset: input.preset,
    aspectRatio: input.aspectRatio,
  });
}
