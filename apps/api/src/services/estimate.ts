import type { CostEstimate, JobType, ProjectDetail, UsageUnit } from "@lvs/shared";

/**
 * Placeholder price table (USD). TODO(pipeline): @lvs/pipeline owns real per-provider
 * pricing; this file should then only call into it.
 */
const PRICE: Record<string, Partial<Record<UsageUnit, number>>> = {
  gemini: { tokens_in: 1.25 / 1e6, tokens_out: 10 / 1e6 },
  anthropic: { tokens_in: 3 / 1e6, tokens_out: 15 / 1e6 },
  "gemini-tts": { chars: 10 / 1e6 },
  elevenlabs: { chars: 0.0003 },
  heygen: { avatar_seconds: 0.02 },
  render: { render_seconds: 0.001 },
};

function line(providerId: string, unit: UsageUnit, quantity: number) {
  const unitPrice = PRICE[providerId]?.[unit] ?? 0;
  return { providerId, unit, quantity, estimatedCost: Math.round(quantity * unitPrice * 1e4) / 1e4 };
}

export function estimateJob(detail: ProjectDetail, type: JobType): CostEstimate {
  const s = detail.project.settings;
  const lines: CostEstimate["lines"] = [];
  const visibleScenes = detail.scenes.filter((sc) => !detail.slides.find((sl) => sl.id === sc.slideId)?.hidden);
  const totalChars = visibleScenes.reduce((n, sc) => n + (detail.scripts[sc.id]?.pronunciationText.length ?? 0), 0);
  const slideChars = detail.slides.reduce((n, sl) => n + sl.content.plainText.length + (sl.content.notes?.length ?? 0), 0);
  switch (type) {
    case "generate_outline":
      lines.push(line(s.llmProviderId, "tokens_in", Math.ceil(slideChars * 1.2) + 2000));
      lines.push(line(s.llmProviderId, "tokens_out", 1500));
      break;
    case "generate_script":
      lines.push(line(s.llmProviderId, "tokens_in", visibleScenes.length * 2500 + Math.ceil(slideChars * 1.2)));
      lines.push(line(s.llmProviderId, "tokens_out", visibleScenes.length * 500));
      break;
    case "synthesize_speech":
      lines.push(line(s.voice.providerId, "chars", totalChars));
      break;
    case "generate_avatar":
      lines.push(line(s.avatar.providerId ?? "heygen", "avatar_seconds", Math.ceil(detail.totalDurationSec)));
      break;
    case "render_video":
      lines.push(line("render", "render_seconds", Math.ceil(detail.totalDurationSec)));
      break;
    default:
      break;
  }
  const total = Math.round(lines.reduce((n, l) => n + l.estimatedCost, 0) * 1e4) / 1e4;
  return { lines, total, currency: "USD" };
}
