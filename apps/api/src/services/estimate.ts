import type { CostEstimate, JobType, ProjectDetail } from "@lvs/shared";
import { estimateCost } from "@lvs/pipeline";
import {
  audioReady,
  avatarTargets,
  narrationSeconds,
  outlineNeedsRegeneration,
  scriptTargets,
  speechTargets,
  visibleScenesOf,
  type SelectionOptions,
} from "../jobs/plan.js";

/** Prompt characters the script writer adds on top of the slide text (outline, neighbours, instructions). */
const SCRIPT_PROMPT_OVERHEAD_CHARS = 2500;

export type EstimateOptions = SelectionOptions;

const round2 = (n: number) => Math.round(n * 100) / 100;

function merge(parts: CostEstimate[], sceneCount: number, seconds: number): CostEstimate {
  const lines = parts.flatMap((p) => p.lines);
  return {
    lines,
    total: Math.round(lines.reduce((a, l) => a + l.estimatedCost, 0) * 10_000) / 10_000,
    currency: parts[0]?.currency ?? "USD",
    sceneCount,
    seconds: round2(seconds),
  };
}

/**
 * Order-of-magnitude cost of running `type` on the project right now (pipeline price table).
 * By default only the pages the job would actually process (`force: false`) are counted;
 * `force: true` counts everything a forced run would redo. `sceneIds` narrows the pool exactly
 * like the job payload does. Selection is shared with the handlers (jobs/plan.ts).
 */
export function estimateJob(detail: ProjectDetail, type: JobType, opts: EstimateOptions = {}): CostEstimate {
  const s = detail.project.settings;
  const bySlide = new Map(detail.slides.map((sl) => [sl.id, sl]));
  const slideChars = (slideId: string) => {
    const sl = bySlide.get(slideId);
    return sl ? sl.content.plainText.length + (sl.content.notes?.length ?? 0) : 0;
  };
  const secondsOf = (scenes: ProjectDetail["scenes"]) => scenes.reduce((n, sc) => n + narrationSeconds(detail, sc), 0);
  const outlineEstimate = (visible: ProjectDetail["scenes"]) =>
    estimateCost("generate_outline", {
      providerId: s.llmProviderId,
      chars: visible.reduce((n, sc) => n + slideChars(sc.slideId), 0) + 2000,
      calls: 1,
      outputTokensPerCall: 1500,
    });

  switch (type) {
    case "generate_outline": {
      const visible = visibleScenesOf(detail);
      const pending = visible.length > 0 && (!!opts.force || outlineNeedsRegeneration(detail));
      if (!pending) return merge([], 0, 0);
      return merge([outlineEstimate(visible)], visible.length, secondsOf(visible));
    }
    case "generate_script": {
      const targets = scriptTargets(detail, opts);
      const parts: CostEstimate[] = [];
      // The handler plans the outline first when it is missing or out of date.
      if (outlineNeedsRegeneration(detail)) parts.push(outlineEstimate(visibleScenesOf(detail)));
      const n = targets.length;
      // `chars` is per call in estimateCost, so the total scales with the number of pending pages.
      const charsPerCall = n ? SCRIPT_PROMPT_OVERHEAD_CHARS + targets.reduce((a, sc) => a + slideChars(sc.slideId), 0) / n : 0;
      parts.push(estimateCost("generate_script", { providerId: s.llmProviderId, chars: charsPerCall, calls: n, outputTokensPerCall: 600 }));
      return merge(parts, n, secondsOf(targets));
    }
    case "synthesize_speech": {
      const targets = speechTargets(detail, opts);
      const chars = targets.reduce((n, sc) => n + (detail.scripts[sc.id]?.pronunciationText.length ?? 0), 0);
      return merge([estimateCost("synthesize_speech", { providerId: s.voice.providerId, chars })], targets.length, secondsOf(targets));
    }
    case "generate_avatar": {
      const targets = avatarTargets(detail, opts);
      const seconds = secondsOf(targets);
      const parts: CostEstimate[] = [];
      // Pages without up-to-date audio get their narration synthesized first, in the same job.
      const needAudio = targets.filter((sc) => !audioReady(sc));
      if (needAudio.length) {
        const chars = needAudio.reduce((n, sc) => n + (detail.scripts[sc.id]?.pronunciationText.length ?? 0), 0);
        parts.push(estimateCost("synthesize_speech", { providerId: s.voice.providerId, chars }));
      }
      parts.push(estimateCost("generate_avatar", { providerId: s.avatar.providerId ?? "heygen", seconds: Math.ceil(seconds) }));
      return merge(parts, targets.length, seconds);
    }
    case "render_video": {
      const visible = visibleScenesOf(detail);
      return merge([estimateCost("render_video", { seconds: Math.ceil(detail.totalDurationSec) })], visible.length, detail.totalDurationSec);
    }
    default:
      return merge([], 0, 0);
  }
}
