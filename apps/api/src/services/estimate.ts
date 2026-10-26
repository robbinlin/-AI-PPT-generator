import type { CostEstimate, JobType, ProjectDetail } from "@lvs/shared";
import { avatarInVideo } from "@lvs/shared";
import { avatarEngine, estimateCost } from "@lvs/pipeline";
import {
  audioReady,
  avatarTargets,
  narrationSeconds,
  outlineNeedsRegeneration,
  scriptJobReplansOutline,
  scriptTargets,
  speechTargets,
  visibleScenesOf,
  type SelectionOptions,
} from "../jobs/plan.js";
import { avatarInputHash } from "../jobs/hashes.js";

/** Prompt characters the script writer adds on top of the slide text (outline, neighbours, instructions). */
const SCRIPT_PROMPT_OVERHEAD_CHARS = 2500;
/** Instructions + glossary in a translation prompt. */
const TRANSLATE_PROMPT_OVERHEAD_CHARS = 1500;

export type EstimateOptions = SelectionOptions & {
  /**
   * Input hashes of the presenter clips this project already has. A pending page whose clip for its
   * current voice and presenter exists is reused by the job for free (switching back to a presenter
   * used before), so it is not priced.
   */
  avatarClipHashes?: ReadonlySet<string>;
};

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
      const replans = scriptJobReplansOutline(detail, opts);
      if (replans) parts.push(outlineEstimate(visibleScenesOf(detail)));
      const n = targets.length;
      // `chars` is per call in estimateCost, so the total scales with the number of pending pages.
      const charsPerCall = n ? SCRIPT_PROMPT_OVERHEAD_CHARS + targets.reduce((a, sc) => a + slideChars(sc.slideId), 0) / n : 0;
      parts.push(estimateCost("generate_script", { providerId: s.llmProviderId, chars: charsPerCall, calls: n, outputTokensPerCall: 600 }));
      return { ...merge(parts, n, secondsOf(targets)), ...(replans ? { replansOutline: true } : {}) };
    }
    case "synthesize_speech": {
      const targets = speechTargets(detail, opts);
      const chars = targets.reduce((n, sc) => n + (detail.scripts[sc.id]?.pronunciationText.length ?? 0), 0);
      return merge([estimateCost("synthesize_speech", { providerId: s.voice.providerId, voiceId: s.voice.voiceId, chars })], targets.length, secondsOf(targets));
    }
    case "generate_avatar": {
      if (!avatarInVideo(s.avatar)) return merge([], 0, 0);
      const targets = avatarTargets(detail, opts);
      // Only "fill in what is missing" reuses: a forced estimate prices redoing every clip (what a
      // script or voice change would cost, when the old clips no longer fit).
      const reusable = (sc: ProjectDetail["scenes"][number]) =>
        !opts.force && !!opts.avatarClipHashes && audioReady(sc) && !!sc.audio.assetId && opts.avatarClipHashes.has(avatarInputHash({ audioAssetId: sc.audio.assetId, settings: s }));
      const reused = targets.filter(reusable);
      const paid = targets.filter((sc) => !reusable(sc));
      const seconds = secondsOf(paid);
      const parts: CostEstimate[] = [];
      // Pages without up-to-date audio get their narration synthesized first, in the same job.
      const needAudio = paid.filter((sc) => !audioReady(sc));
      if (needAudio.length) {
        const chars = needAudio.reduce((n, sc) => n + (detail.scripts[sc.id]?.pronunciationText.length ?? 0), 0);
        parts.push(estimateCost("synthesize_speech", { providerId: s.voice.providerId, voiceId: s.voice.voiceId, chars }));
      }
      if (paid.length || !reused.length) {
        parts.push(estimateCost("generate_avatar", { providerId: s.avatar.providerId ?? "heygen", seconds: Math.ceil(seconds), engine: avatarEngine(s.avatar) }));
      }
      return { ...merge(parts, targets.length, seconds), ...(reused.length ? { reusedSceneCount: reused.length } : {}) };
    }
    case "translate_script": {
      // Estimated on the SOURCE project: one LLM call per page that has a script, each prompt
      // carrying that page plus its neighbours as context.
      const pages = visibleScenesOf(detail).filter((sc) => detail.scripts[sc.id]?.script.trim());
      const n = pages.length;
      const chars = pages.reduce((a, sc) => a + detail.scripts[sc.id]!.script.length, 0);
      const perCall = n ? TRANSLATE_PROMPT_OVERHEAD_CHARS + (3 * chars) / n : 0;
      const outPerCall = n ? Math.ceil((chars / n) * 1.5) : 0; // English runs ~1.5 tokens per Chinese character
      return merge([estimateCost("generate_script", { providerId: s.llmProviderId, chars: perCall, calls: n, outputTokensPerCall: outPerCall })], n, secondsOf(pages));
    }
    case "render_video": {
      const visible = visibleScenesOf(detail);
      return merge([estimateCost("render_video", { seconds: Math.ceil(detail.totalDurationSec) })], visible.length, detail.totalDurationSec);
    }
    default:
      return merge([], 0, 0);
  }
}
