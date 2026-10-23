/**
 * Which scenes each generation job would process. Shared by the job handlers and the cost
 * estimate so "what clicking the button costs" is computed from exactly the same selection.
 */
import type { ProjectDetail, Scene } from "@lvs/shared";
import { outlineInputHash, selectScenesToProcess } from "./hashes.js";

export interface SelectionOptions {
  sceneIds?: string[];
  force?: boolean;
}

/** Page number the editor shows for a scene (P1, P2… in the current order). */
export const pageNo = (scene: Pick<Scene, "index">): number => scene.index + 1;

/** "第 2、3、5 頁" style list of page numbers. */
export function pageList(scenes: Array<Pick<Scene, "index">>): string {
  return [...new Set(scenes.map(pageNo))].sort((a, b) => a - b).join("、");
}

export function visibleScenesOf(detail: Pick<ProjectDetail, "slides" | "scenes">): Scene[] {
  const hidden = new Set(detail.slides.filter((s) => s.hidden).map((s) => s.id));
  return detail.scenes.filter((sc) => !hidden.has(sc.slideId));
}

/** True when generate_script would (re)plan the outline before writing scripts. */
export function outlineNeedsRegeneration(detail: ProjectDetail): boolean {
  const bySlide = new Map(detail.slides.map((s) => [s.id, s]));
  const slidesInOrder = visibleScenesOf(detail)
    .map((sc) => bySlide.get(sc.slideId))
    .filter((s): s is NonNullable<typeof s> => !!s);
  if (slidesInOrder.length === 0) return false;
  return !detail.outline || detail.outline.inputHash !== outlineInputHash(slidesInOrder, detail.project.settings);
}

export function scriptTargets(detail: ProjectDetail, opts: SelectionOptions = {}): Scene[] {
  const visible = visibleScenesOf(detail);
  // A new outline changes every AI script's input hash, so they all become stale.
  const replan = outlineNeedsRegeneration(detail);
  return selectScenesToProcess(visible, opts.sceneIds, !!opts.force, (s) =>
    replan && detail.scripts[s.id]?.source === "ai" && s.script.status === "ready" ? "stale" : s.script.status,
  );
}

/** Scenes synthesize_speech / generate_avatar can work on: visible, narrated, with a script. */
export function narratedCandidates(detail: ProjectDetail): Scene[] {
  return visibleScenesOf(detail).filter((s) => !s.muted && !!detail.scripts[s.id]);
}

export function speechTargets(detail: ProjectDetail, opts: SelectionOptions = {}): Scene[] {
  return selectScenesToProcess(narratedCandidates(detail), opts.sceneIds, !!opts.force, (s) => s.audio.status);
}

export const audioReady = (s: Scene): boolean => s.audio.status === "ready" && !!s.audio.assetId;

/** A scene without up-to-date audio needs a new avatar clip too (the audio will be redone first). */
export function avatarTargets(detail: ProjectDetail, opts: SelectionOptions = {}): Scene[] {
  return selectScenesToProcess(narratedCandidates(detail), opts.sceneIds, !!opts.force, (s) => (audioReady(s) ? s.avatar.status : "stale"));
}

/** Narration seconds of a scene: real audio when ready, else the script's estimate, else chars / 4.5. */
export function narrationSeconds(detail: ProjectDetail, s: Scene): number {
  const script = detail.scripts[s.id];
  if (audioReady(s) && s.durationSec) return s.durationSec;
  if (script?.estimatedDurationSec) return script.estimatedDurationSec;
  return script ? script.script.length / 4.5 : 0;
}
