/**
 * Which scenes each generation job would process. Shared by the job handlers and the cost
 * estimate so "what clicking the button costs" is computed from exactly the same selection.
 */
import type { ProjectDetail, Scene } from "@lvs/shared";
import { outlineInputHash, selectScenesToProcess } from "./hashes.js";

export interface SelectionOptions {
  sceneIds?: string[];
  force?: boolean;
  /** The running job: pages it already finished are skipped when it is retried (see doneBy). */
  jobId?: string;
}

/**
 * A forced job that fails part-way is retried from the start; without this it would pay again for
 * every page it had already finished (and a translation would overwrite edits made meanwhile).
 */
export function doneBy(jobId: string | undefined, state: { status: string; jobId?: string }): boolean {
  return !!jobId && state.jobId === jobId && state.status === "ready";
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

/**
 * The stored outline is out of date only because pages were hidden, shown again or moved: the pages it
 * planned, read in its own order with today's settings, still give its hash (same text, same 長度/對象/
 * 風格). A settings or content change gives another hash.
 */
function outlineOnlyLacksPageChanges(detail: ProjectDetail): boolean {
  const outline = detail.outline;
  if (!outline) return false;
  const bySlide = new Map(detail.slides.map((s) => [s.id, s]));
  const planned = outline.sections.flatMap((sec) => sec.slideIds).map((id) => bySlide.get(id));
  if (!planned.length || planned.some((s) => !s)) return false;
  const matches = (slides: typeof planned) => outlineInputHash(slides.map((s) => ({ ...s!, hidden: false })), detail.project.settings) === outline.inputHash;
  // The plan was hashed in deck order; its sections may list pages otherwise (a model that leaves the
  // cover out has it appended under 「其他」), so try the pages in deck order too.
  const position = new Map(detail.scenes.map((sc) => [sc.slideId, sc.index]));
  const inDeckOrder = [...planned].sort((a, b) => (position.get(a!.id) ?? 0) - (position.get(b!.id) ?? 0));
  return matches(inDeckOrder) || matches(planned);
}

/**
 * True when this generate_script job re-plans the outline first: when there is none, after a settings
 * or slide-content change (so 目標總長, 對象, 風格 are followed), or for a whole-deck run. Rewriting chosen
 * pages that the outline already plans, when only hidden/moved pages made it out of date, keeps it —
 * a new one would make every other AI page 需更新.
 */
export function scriptJobReplansOutline(detail: ProjectDetail, opts: SelectionOptions = {}): boolean {
  if (!outlineNeedsRegeneration(detail)) return false;
  if (!detail.outline || !opts.sceneIds?.length) return true;
  if (!outlineOnlyLacksPageChanges(detail)) return true;
  // A page the outline never planned (shown again, or new) has no section and no time share.
  const planned = new Set(detail.outline.sections.flatMap((sec) => sec.slideIds));
  const sceneSlide = new Map(detail.scenes.map((s) => [s.id, s.slideId]));
  return opts.sceneIds.some((id) => !planned.has(sceneSlide.get(id) ?? ""));
}

export function scriptTargets(detail: ProjectDetail, opts: SelectionOptions = {}): Scene[] {
  const visible = visibleScenesOf(detail);
  // A new outline changes every AI script's input hash, so they all become stale.
  const replan = scriptJobReplansOutline(detail, opts);
  return selectScenesToProcess(visible, opts.sceneIds, !!opts.force, (s) =>
    replan && detail.scripts[s.id]?.source === "ai" && s.script.status === "ready" ? "stale" : s.script.status,
  ).filter((s) => !doneBy(opts.jobId, s.script));
}

/** Scenes synthesize_speech / generate_avatar can work on: visible, narrated, with a script. */
export function narratedCandidates(detail: ProjectDetail): Scene[] {
  return visibleScenesOf(detail).filter((s) => !s.muted && !!detail.scripts[s.id]);
}

export function speechTargets(detail: ProjectDetail, opts: SelectionOptions = {}): Scene[] {
  return selectScenesToProcess(narratedCandidates(detail), opts.sceneIds, !!opts.force, (s) => s.audio.status).filter((s) => !doneBy(opts.jobId, s.audio));
}

export const audioReady = (s: Scene): boolean => s.audio.status === "ready" && !!s.audio.assetId;

/** A scene without up-to-date audio needs a new avatar clip too (the audio will be redone first). */
export function avatarTargets(detail: ProjectDetail, opts: SelectionOptions = {}): Scene[] {
  return selectScenesToProcess(narratedCandidates(detail), opts.sceneIds, !!opts.force, (s) => (audioReady(s) ? s.avatar.status : "stale")).filter(
    (s) => !doneBy(opts.jobId, s.avatar),
  );
}

/** Narration seconds of a scene: real audio when ready, else the script's estimate, else chars / 4.5. */
export function narrationSeconds(detail: ProjectDetail, s: Scene): number {
  const script = detail.scripts[s.id];
  if (audioReady(s) && s.durationSec) return s.durationSec;
  if (script?.estimatedDurationSec) return script.estimatedDurationSec;
  return script ? script.script.length / 4.5 : 0;
}
