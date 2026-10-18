/**
 * Input hashes that decide whether a derived asset is up to date. Thin adapters over the
 * canonical implementations in `@lvs/pipeline` (docs/ARCHITECTURE.md "Input hashes") so the
 * API and the pipeline can never disagree about what invalidates what.
 */
import type { DerivedStatus, ProjectSettings, Scene, ScriptRevision, Slide } from "@lvs/shared";
import * as pipeline from "@lvs/pipeline";

export const scriptSettingsSubset = pipeline.scriptSettingsSubset;

/** Outline depends on every visible slide's content, in order, and the script settings. */
export function outlineInputHash(slidesInOrder: Slide[], settings: ProjectSettings): string {
  return pipeline.outlineInputHash({ slideContentHashes: slidesInOrder.filter((s) => !s.hidden).map((s) => s.contentHash), settings });
}

export function scriptInputHash(args: { slide: Slide; prev?: Slide; next?: Slide; outlineInputHash?: string; settings: ProjectSettings }): string {
  return pipeline.scriptInputHash({
    slideContentHash: args.slide.contentHash,
    outlineInputHash: args.outlineInputHash ?? "",
    prevSlideContentHash: args.prev?.contentHash,
    nextSlideContentHash: args.next?.contentHash,
    settings: args.settings,
  });
}

export function audioInputHash(args: {
  pronunciationText: string;
  settings: ProjectSettings;
  glossaryReadings?: Array<{ term: string; reading?: string; definition?: string }>;
}): string {
  return pipeline.audioInputHash({
    pronunciationText: args.pronunciationText,
    voice: args.settings.voice,
    glossary: args.glossaryReadings,
    language: args.settings.language,
  });
}

export function subtitleInputHash(args: { audioInputHash: string; subtitleText: string; settings: ProjectSettings }): string {
  return pipeline.subtitleInputHash({
    audioInputHash: args.audioInputHash,
    subtitleText: args.subtitleText,
    maxCharsPerLine: args.settings.subtitles.style.maxCharsPerLine,
  });
}

export function avatarInputHash(args: { audioAssetId: string; settings: ProjectSettings }): string {
  return pipeline.avatarInputHash({
    audioAssetId: args.audioAssetId,
    providerId: args.settings.avatar.providerId ?? "",
    avatarId: args.settings.avatar.avatarId ?? "",
    aspectRatio: args.settings.aspectRatio,
  });
}

export function renderInputHash(args: { scenesInOrder: Scene[]; settings: ProjectSettings; preset: string; burnSubtitles: boolean }): string {
  return pipeline.renderInputHash({
    scenes: args.scenesInOrder.map((s) => ({
      sceneId: s.id,
      audioAssetId: s.audio.assetId,
      avatarVideoAssetId: s.avatar.assetId,
      subtitleAssetId: s.subtitle.assetId,
      muted: s.muted,
      tailPauseSec: s.tailPauseSec,
      avatarLayout: s.avatarLayout,
      transitionIn: s.transitionIn,
    })),
    subtitleStyle: args.settings.subtitles.style,
    burnSubtitles: args.burnSubtitles,
    transition: args.settings.transition,
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
