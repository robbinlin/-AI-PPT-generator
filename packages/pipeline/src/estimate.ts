import type { CostEstimate, UsageUnit } from "@lvs/shared";

/**
 * PLACEHOLDER PRICES (USD). These are rough public list prices as of 2026 and
 * exist so the UI can show an order-of-magnitude estimate before a job runs.
 * Replace with the operator's negotiated rates in configuration.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  llm: {
    gemini: { tokensInPer1k: 0.00125, tokensOutPer1k: 0.01 },
    anthropic: { tokensInPer1k: 0.004, tokensOutPer1k: 0.02 },
    mock: { tokensInPer1k: 0, tokensOutPer1k: 0 },
  },
  tts: {
    gemini: { charsPer1k: 0.02 },
    elevenlabs: { charsPer1k: 0.18 },
    // 雅婷: NT$298 per 100,000 characters (developer.yating.tw/pricing, 2026-10) ≈ US$0.093 per 1k.
    yating: { charsPer1k: 0.093 },
    mock: { charsPer1k: 0 },
  },
  avatar: {
    // HeyGen API pay-as-you-go (heygen.com/blog/ai-video-generator-pricing, 2026-10-20):
    // Avatar IV photo avatar $0.05/s (the default), Avatar III digital twin $0.0167/s.
    heygen: { perSecond: 0.05, perSecondByEngine: { avatar_iii: 0.0167, avatar_v: 0.0667 } },
    mock: { perSecond: 0 },
  },
  render: { perSecond: 0.002 },
  currency: "USD",
};

export interface PriceTable {
  llm: Record<string, { tokensInPer1k: number; tokensOutPer1k: number }>;
  tts: Record<string, { charsPer1k: number }>;
  avatar: Record<string, { perSecond: number; perSecondByEngine?: Record<string, number> }>;
  render: { perSecond: number };
  currency: string;
}

export type EstimateKind = "generate_outline" | "generate_script" | "synthesize_speech" | "generate_avatar" | "render_video";

export interface EstimateInputs {
  providerId?: string;
  /** Total prompt characters (LLM) or text characters (TTS). */
  chars?: number;
  /** Expected output tokens per call (LLM). */
  outputTokensPerCall?: number;
  /** Number of LLM calls, e.g. scenes to script. */
  calls?: number;
  /** Narration seconds already known or estimated (avatar/render). */
  seconds?: number;
  /** Avatar rendering engine (see `avatarEngine`); priced per engine where the table says. */
  engine?: string;
}

/**
 * Engine a project's avatar renders with: HeyGen video twins use Avatar III (their motion comes
 * from the recording, a third of Avatar IV's price); everything else keeps the provider default.
 */
export function avatarEngine(avatar: { providerId?: string; avatarSource?: "photo" | "video" }): string | undefined {
  return avatar.providerId === "heygen" && avatar.avatarSource === "video" ? "avatar_iii" : undefined;
}

/** Order-of-magnitude cost before a job runs. Never used for billing. */
export function estimateCost(kind: EstimateKind, inputs: EstimateInputs, table: PriceTable = DEFAULT_PRICE_TABLE): CostEstimate {
  const lines: CostEstimate["lines"] = [];
  const add = (providerId: string, unit: UsageUnit, quantity: number, estimatedCost: number) =>
    lines.push({ providerId, unit, quantity: round(quantity), estimatedCost: round(estimatedCost, 4) });

  switch (kind) {
    case "generate_outline":
    case "generate_script": {
      const id = inputs.providerId ?? "gemini";
      const p = table.llm[id] ?? { tokensInPer1k: 0, tokensOutPer1k: 0 };
      const calls = inputs.calls ?? 1;
      const tokensIn = Math.ceil((inputs.chars ?? 0) / 3) * calls; // ~3 chars/token for mixed zh/en
      const tokensOut = (inputs.outputTokensPerCall ?? (kind === "generate_outline" ? 2000 : 800)) * calls;
      add(id, "tokens_in", tokensIn, (tokensIn / 1000) * p.tokensInPer1k);
      add(id, "tokens_out", tokensOut, (tokensOut / 1000) * p.tokensOutPer1k);
      break;
    }
    case "synthesize_speech": {
      const id = inputs.providerId ?? "gemini";
      const p = table.tts[id] ?? { charsPer1k: 0 };
      const chars = inputs.chars ?? 0;
      add(id, "chars", chars, (chars / 1000) * p.charsPer1k);
      break;
    }
    case "generate_avatar": {
      const id = inputs.providerId ?? "heygen";
      const p = table.avatar[id] ?? { perSecond: 0 };
      const rate = (inputs.engine ? p.perSecondByEngine?.[inputs.engine] : undefined) ?? p.perSecond;
      const s = inputs.seconds ?? 0;
      add(id, "avatar_seconds", s, s * rate);
      break;
    }
    case "render_video": {
      const s = inputs.seconds ?? 0;
      add("render", "render_seconds", s, s * table.render.perSecond);
      break;
    }
  }
  return { lines, total: round(lines.reduce((a, l) => a + l.estimatedCost, 0), 4), currency: table.currency };
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
