import { randomUUID } from "node:crypto";
import type { UsageUnit } from "@lvs/shared";

export interface UsageLine {
  unit: UsageUnit;
  quantity: number;
}
import { DEFAULT_PRICE_TABLE } from "@lvs/pipeline";
import type { Db } from "../db/client.js";
import { usageRecords } from "../db/schema.js";

/** Persist what a provider call consumed, with a rough cost from the placeholder price table. */
export async function recordUsage(
  db: Db,
  args: { projectId: string; jobId?: string; providerId: string; usage: UsageLine[] },
): Promise<void> {
  if (args.usage.length === 0) return;
  const t = DEFAULT_PRICE_TABLE;
  const cost = (u: UsageLine): number | null => {
    switch (u.unit) {
      case "tokens_in":
        return (u.quantity / 1000) * (t.llm[args.providerId]?.tokensInPer1k ?? 0);
      case "tokens_out":
        return (u.quantity / 1000) * (t.llm[args.providerId]?.tokensOutPer1k ?? 0);
      case "chars":
        return (u.quantity / 1000) * (t.tts[args.providerId]?.charsPer1k ?? 0);
      case "avatar_seconds":
        return u.quantity * (t.avatar[args.providerId]?.perSecond ?? 0);
      case "render_seconds":
        return u.quantity * t.render.perSecond;
      default:
        return null;
    }
  };
  await db.insert(usageRecords).values(
    args.usage.map((u) => {
      const c = cost(u);
      return {
        id: randomUUID(),
        projectId: args.projectId,
        jobId: args.jobId ?? null,
        providerId: args.providerId,
        unit: u.unit,
        quantity: u.quantity,
        estimatedCost: c === null ? null : Math.round(c * 1e6) / 1e6,
        currency: t.currency,
      };
    }),
  );
}
