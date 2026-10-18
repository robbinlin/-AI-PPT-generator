import type { RenderScene } from "@lvs/shared";
import type { TimedCue } from "./subtitles.js";

export interface TimelineEntry {
  sceneId: string;
  durationSec: number;
  /** Start of the scene on the output timeline. */
  startSec: number;
  /** Overlap with the previous scene (0 for the first scene or `transitionIn: none`). */
  transitionInSec: number;
  transition: "none" | "fade";
}

export interface Timeline {
  entries: TimelineEntry[];
  totalSec: number;
  hasFades: boolean;
}

/**
 * Lays scenes out on the output timeline. A `fade` on scene i overlaps scenes i-1 and i by
 * `transitionDurationSec`, clamped to at most half of either neighbour so two transitions
 * can never consume a whole scene. `transitionIn` of the first scene is ignored (there is
 * nothing to fade from).
 */
export function computeTimeline(scenes: readonly RenderScene[]): Timeline {
  const entries: TimelineEntry[] = [];
  let cursor = 0;
  let hasFades = false;
  scenes.forEach((scene, i) => {
    const prev = scenes[i - 1];
    let overlap = 0;
    const isFade = i > 0 && prev !== undefined && scene.transitionIn === "fade";
    if (isFade) {
      overlap = Math.min(scene.transitionDurationSec, prev.durationSec / 2, scene.durationSec / 2);
      // Round to the millisecond so the filter graph and the SRT agree exactly.
      overlap = Math.max(0, Math.floor(overlap * 1000) / 1000);
    }
    const fade = isFade && overlap > 0;
    if (fade) hasFades = true;
    const startSec = Math.max(0, cursor - overlap);
    entries.push({
      sceneId: scene.sceneId,
      durationSec: scene.durationSec,
      startSec,
      transitionInSec: fade ? overlap : 0,
      transition: fade ? "fade" : "none",
    });
    cursor = startSec + scene.durationSec;
  });
  return { entries, totalSec: cursor, hasFades };
}

/** All cues of all scenes on the global timeline, clipped to their scene and sorted. */
export function globalCues(scenes: readonly RenderScene[], timeline: Timeline): TimedCue[] {
  const out: TimedCue[] = [];
  scenes.forEach((scene, i) => {
    const entry = timeline.entries[i];
    if (!entry) return;
    const sorted = [...scene.subtitles].sort((a, b) => a.startSec - b.startSec || a.index - b.index);
    for (const cue of sorted) {
      const start = Math.max(0, cue.startSec);
      const end = Math.min(cue.endSec, scene.durationSec);
      if (!(end > start) || !cue.text.trim()) continue;
      out.push({ startSec: entry.startSec + start, endSec: entry.startSec + end, text: cue.text });
    }
  });
  // Stable sort: cues of a fading-in scene may start before the previous scene's last cue ends.
  return out.sort((a, b) => a.startSec - b.startSec);
}
