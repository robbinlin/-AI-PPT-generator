import type { Scene, ScriptRevision, Slide } from "@lvs/shared";

/** Hold time for a muted page, mirroring the API's MUTED_SCENE_SEC. */
export const MUTED_SCENE_SEC = 3;
/** Shown for pages with neither audio nor an estimate yet. */
const FALLBACK_SEC = 5;

export interface TimelineBlock {
  scene: Scene;
  slide: Slide;
  index: number;
  /** Seconds from the start of the video. */
  start: number;
  /** Narration length (measured, or the model's estimate when `estimated`). */
  narration: number;
  tail: number;
  total: number;
  estimated: boolean;
}

/**
 * Page blocks in video order with start times, as the renderer lays them out: narration
 * (or the hold time for muted pages) plus the page's tail pause. Hidden slides are skipped.
 * `tailOverride` previews a tail pause that is still being dragged.
 */
export function buildTimeline(
  scenes: readonly Scene[],
  slides: readonly Slide[],
  scripts: Readonly<Record<string, ScriptRevision | undefined>>,
  tailOverride?: { sceneId: string; tail: number },
): { blocks: TimelineBlock[]; totalSec: number } {
  const slideById = new Map(slides.map((s) => [s.id, s]));
  const ordered = [...scenes].sort((a, b) => a.index - b.index);
  const blocks: TimelineBlock[] = [];
  let t = 0;
  for (const scene of ordered) {
    const slide = slideById.get(scene.slideId);
    if (!slide || slide.hidden) continue;
    let narration: number;
    let estimated = false;
    if (scene.muted) narration = MUTED_SCENE_SEC;
    else if (scene.durationSec && scene.audio.status !== "missing") narration = scene.durationSec;
    else {
      narration = scripts[scene.id]?.estimatedDurationSec ?? FALLBACK_SEC;
      estimated = true;
    }
    const tail = tailOverride?.sceneId === scene.id ? tailOverride.tail : (scene.tailPauseSec ?? 0.5);
    const total = Math.max(0.5, narration + tail);
    blocks.push({ scene, slide, index: blocks.length, start: t, narration, tail, total, estimated });
    t += total;
  }
  return { blocks, totalSec: t };
}

/** Peaks (0..1) of an audio buffer's first channel, `buckets` values. */
export function computePeaks(samples: Float32Array, buckets: number): number[] {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const from = b * step;
    const to = Math.min(samples.length, from + step);
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i]!);
      if (v > max) max = v;
    }
    out.push(max);
  }
  const peak = Math.max(...out, 1e-6);
  return out.map((v) => Math.min(1, v / peak));
}
