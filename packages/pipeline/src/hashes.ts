import type { AspectRatio, AvatarLayout, GlossaryEntry, ProjectSettings, SubtitleStyle, Transition } from "@lvs/shared";
import { contentHash, fittedSlideScale } from "@lvs/shared";

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
    // Bump when the way text is sent to TTS changes (v2: no instruction prefix, which 3.x models read aloud).
    recipe: 2,
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

export function avatarInputHash(input: { audioAssetId: string; providerId: string; avatarId: string; aspectRatio: AspectRatio; engine?: string }): string {
  return contentHash({
    kind: "avatar",
    audio: input.audioAssetId,
    providerId: input.providerId,
    avatarId: input.avatarId,
    aspectRatio: input.aspectRatio,
    // Only a non-default engine joins the hash, so clips made before engines were chosen stay current.
    ...(input.engine ? { engine: input.engine } : {}),
  });
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
  /** Frame colour around the slide. */
  backgroundColor?: string;
  /** Subtitles on at all (off: no cues burnt in, no SRT). */
  subtitlesEnabled?: boolean;
}): string {
  const [rw, rh] = input.aspectRatio.split(":").map(Number);
  const ratio = rw && rh ? rw / rh : 16 / 9;
  return contentHash({
    kind: "render",
    // Bump together with the render worker's SCENE_RENDER_VERSION whenever its output changes, so a
    // video made the old way reads as outdated and the new one gets its own file
    // (v2: lip-synced avatars play once and hold their last frame instead of looping;
    // v3: pages without a clip keep the presenter pages' slide frame;
    // v4: subtitles move beside the presenter instead of running across it;
    // v5: the slide picture itself counts, so a deck replaced with a changed slide reads outdated;
    // v6: the presenter layout every page really uses, presenter on/off, background colour and
    // subtitles on/off count, so moving the presenter after an export makes the video outdated).
    recipe: 6,
    scenes: input.scenes.map((s) => {
      // A slide the renderer shrinks off the presenter counts only where it is shrunk, so videos
      // made the old way read outdated exactly where the slide ran under the presenter.
      const fitted = fittedSlideScale(s.avatarLayout, ratio);
      return {
        id: s.sceneId,
        image: s.imageAssetId ?? null,
        audio: s.audioAssetId ?? null,
        avatar: s.avatarVideoAssetId ?? null,
        subtitle: s.subtitleAssetId ?? null,
        muted: s.muted,
        tail: s.tailPauseSec,
        layout: s.avatarLayout ?? null,
        transitionIn: s.transitionIn ?? null,
        ...(fitted !== (s.avatarLayout?.slideScale ?? 1) ? { slideFit: fitted } : {}),
      };
    }),
    // The style only shows when subtitles are burnt in; the SRT alone depends on the line width.
    subtitleStyle:
      input.subtitlesEnabled === false
        ? null
        : input.burnSubtitles
          ? input.subtitleStyle
          : { maxCharsPerLine: input.subtitleStyle.maxCharsPerLine },
    burnSubtitles: input.burnSubtitles && input.subtitlesEnabled !== false,
    subtitlesEnabled: input.subtitlesEnabled ?? true,
    backgroundColor: input.backgroundColor ?? "#000000",
    transition: input.transition,
    preset: input.preset,
    aspectRatio: input.aspectRatio,
  });
}
