/**
 * Input hashes that decide whether a derived asset is up to date.
 * Mirrors the table in docs/ARCHITECTURE.md ("Input hashes"). Pure functions.
 *
 * TODO(pipeline): @lvs/pipeline may export equivalents; when it does, re-export from here so
 * the API and the pipeline never disagree about what invalidates what.
 */
import { contentHash, type DerivedStatus, type ProjectSettings, type Scene, type ScriptRevision, type Slide } from "@lvs/shared";

export function scriptSettingsSubset(s: ProjectSettings) {
  return {
    language: s.language,
    audience: s.audience,
    audienceNote: s.audienceNote,
    mode: s.mode,
    contentBoundary: s.contentBoundary,
    targetDurationSec: s.targetDurationSec,
    styleNote: s.styleNote,
    llmProviderId: s.llmProviderId,
  };
}

/** Outline depends on every visible slide's content, in order, and the script settings. */
export function outlineInputHash(slidesInOrder: Slide[], settings: ProjectSettings): string {
  return contentHash({
    kind: "outline",
    slides: slidesInOrder.filter((s) => !s.hidden).map((s) => s.contentHash),
    settings: scriptSettingsSubset(settings),
  });
}

export function scriptInputHash(args: {
  slide: Slide;
  prev?: Slide;
  next?: Slide;
  outlineInputHash?: string;
  settings: ProjectSettings;
}): string {
  return contentHash({
    kind: "script",
    slide: args.slide.contentHash,
    prev: args.prev?.contentHash,
    next: args.next?.contentHash,
    outline: args.outlineInputHash,
    settings: scriptSettingsSubset(args.settings),
  });
}

export function audioInputHash(args: {
  pronunciationText: string;
  settings: ProjectSettings;
  glossaryReadings?: Array<{ term: string; reading?: string }>;
}): string {
  const v = args.settings.voice;
  return contentHash({
    kind: "audio",
    text: args.pronunciationText,
    voice: { providerId: v.providerId, voiceId: v.voiceId, speed: v.speed, sentencePauseSec: v.sentencePauseSec },
    language: args.settings.language,
    glossary: (args.glossaryReadings ?? []).filter((g) => g.reading).map((g) => [g.term, g.reading]),
  });
}

export function subtitleInputHash(args: { audioInputHash: string; subtitleText: string; settings: ProjectSettings }): string {
  return contentHash({
    kind: "subtitle",
    audio: args.audioInputHash,
    text: args.subtitleText,
    maxCharsPerLine: args.settings.subtitles.style.maxCharsPerLine,
  });
}

export function avatarInputHash(args: { audioAssetId: string; settings: ProjectSettings }): string {
  return contentHash({
    kind: "avatar",
    audioAssetId: args.audioAssetId,
    providerId: args.settings.avatar.providerId,
    avatarId: args.settings.avatar.avatarId,
    aspectRatio: args.settings.aspectRatio,
  });
}

export function renderInputHash(args: {
  scenesInOrder: Scene[];
  settings: ProjectSettings;
  preset: string;
  burnSubtitles: boolean;
}): string {
  return contentHash({
    kind: "render",
    scenes: args.scenesInOrder.map((s) => ({
      audio: s.audio.assetId,
      avatar: s.avatar.assetId,
      subtitle: s.subtitle.assetId,
      muted: s.muted,
      layout: s.avatarLayout ?? args.settings.avatar.layout,
      transition: s.transitionIn ?? args.settings.transition,
      tail: s.tailPauseSec,
    })),
    subtitleStyle: args.settings.subtitles.style,
    burn: args.burnSubtitles,
    preset: args.preset,
    aspectRatio: args.settings.aspectRatio,
  });
}

/** Status a scene asset state should display given the hash its inputs produce now. */
export function effectiveStatus(state: { status: DerivedStatus; inputHash?: string }, currentHash: string): DerivedStatus {
  if (state.status === "ready" && state.inputHash !== currentHash) return "stale";
  return state.status;
}

/** Scenes a job must process: those `missing`/`stale`/`failed`, or all when `force`. */
export function selectScenesToProcess<T extends { id: string }>(
  candidates: T[],
  requestedIds: string[] | undefined,
  force: boolean,
  statusOf: (scene: T) => DerivedStatus,
): T[] {
  const pool = requestedIds ? candidates.filter((c) => requestedIds.includes(c.id)) : candidates;
  if (force) return pool;
  return pool.filter((c) => {
    const s = statusOf(c);
    return s === "missing" || s === "stale" || s === "failed";
  });
}

export function latestScriptHashInputs(rev: ScriptRevision | undefined) {
  return rev ? { pronunciationText: rev.pronunciationText, subtitleText: rev.subtitleText } : undefined;
}
