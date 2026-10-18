import type { CostEstimate, JobType, ProjectDetail } from "@lvs/shared";
import { estimateCost, type EstimateKind } from "@lvs/pipeline";

const KINDS: ReadonlySet<string> = new Set(["generate_outline", "generate_script", "synthesize_speech", "generate_avatar", "render_video"]);

/** Order-of-magnitude cost of running `type` on the project right now (pipeline price table). */
export function estimateJob(detail: ProjectDetail, type: JobType): CostEstimate {
  if (!KINDS.has(type)) return { lines: [], total: 0, currency: "USD" };
  const kind = type as EstimateKind;
  const s = detail.project.settings;
  const hidden = new Set(detail.slides.filter((sl) => sl.hidden).map((sl) => sl.id));
  const visibleScenes = detail.scenes.filter((sc) => !hidden.has(sc.slideId));
  const slideChars = detail.slides
    .filter((sl) => !sl.hidden)
    .reduce((n, sl) => n + sl.content.plainText.length + (sl.content.notes?.length ?? 0), 0);
  const scriptChars = visibleScenes.reduce((n, sc) => n + (detail.scripts[sc.id]?.pronunciationText.length ?? 0), 0);
  switch (kind) {
    case "generate_outline":
      return estimateCost(kind, { providerId: s.llmProviderId, chars: slideChars + 2000, calls: 1, outputTokensPerCall: 1500 });
    case "generate_script":
      return estimateCost(kind, {
        providerId: s.llmProviderId,
        chars: visibleScenes.length * 2500 + slideChars,
        calls: Math.max(1, visibleScenes.length),
        outputTokensPerCall: 600,
      });
    case "synthesize_speech":
      return estimateCost(kind, { providerId: s.voice.providerId, chars: scriptChars });
    case "generate_avatar":
      return estimateCost(kind, { providerId: s.avatar.providerId ?? "heygen", seconds: Math.ceil(detail.totalDurationSec) });
    case "render_video":
      return estimateCost(kind, { seconds: Math.ceil(detail.totalDurationSec) });
  }
}
