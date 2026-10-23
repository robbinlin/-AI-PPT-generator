import type { CostEstimate, EnqueueJobRequest } from "@lvs/shared";
import type { EstimateType } from "../api/types";
import { fmt, t } from "../i18n";
import { formatCostTwd, formatTwdFirst, formatWait, TWD_PER_USD } from "./format";

/** Job types that cost money or real time and therefore get an estimate before they start. */
export const ESTIMATED_TYPES: ReadonlySet<string> = new Set<EstimateType>(["generate_script", "synthesize_speech", "generate_avatar"]);

/** Cost above which even a "fill in what's missing" run asks first. */
export const CONFIRM_THRESHOLD_USD = 0.5;

export function isForced(req: EnqueueJobRequest): boolean {
  return "force" in req && req.force === true;
}

export function requestedScenes(req: EnqueueJobRequest): string[] | undefined {
  return "sceneIds" in req ? req.sceneIds : undefined;
}

/**
 * Rough wall-clock wait. Avatar timings come from HeyGen runs on this project (a short page took
 * 1–7 minutes depending on their queue); local MuseTalk runs at roughly 3x real time on the lab GPU.
 */
export function estimateWaitSec(type: EstimateType, estimate: CostEstimate, avatarProviderId?: string): number {
  const pages = estimate.sceneCount ?? 0;
  const seconds = estimate.seconds ?? 0;
  switch (type) {
    case "generate_script":
      return pages * 15;
    case "synthesize_speech":
      return pages * 8;
    case "generate_avatar":
      return avatarProviderId === "local" ? 20 + seconds * 3 : pages * 90 + seconds * 6;
    case "render_video":
      return 20 + seconds * 0.5;
  }
}

/** Avatars always ask (each page costs real money); forced reruns and anything above the threshold too. */
export function needsConfirm(req: EnqueueJobRequest, estimate: CostEstimate): boolean {
  if ((estimate.sceneCount ?? 1) === 0) return false;
  if (req.type === "generate_avatar") return true;
  if (isForced(req) && (estimate.sceneCount ?? 2) > 1) return true;
  return estimate.total >= CONFIRM_THRESHOLD_USD;
}

/** Breakdown lines such as "語音 1,234 字：US$0.004" for the confirm dialog and the header tooltip. */
export function estimateLines(estimate: CostEstimate): string[] {
  const out: string[] = [];
  for (const line of estimate.lines) {
    const q = Math.round(line.quantity).toLocaleString("zh-TW");
    const what =
      line.unit === "chars"
        ? fmt(t.paid.lineSpeech, { n: q })
        : line.unit === "avatar_seconds"
          ? fmt(t.paid.lineAvatar, { n: q })
          : line.unit === "tokens_in" || line.unit === "tokens_out"
            ? t.paid.lineScript
            : null;
    if (what) out.push(`${what}：${formatCostTwd(line.estimatedCost)}`);
  }
  return out;
}

export function confirmContent(type: EstimateType, req: EnqueueJobRequest, estimate: CostEstimate, avatarProviderId?: string) {
  const pages = estimate.sceneCount;
  const wait = estimateWaitSec(type, estimate, avatarProviderId);
  const lines = [
    ...(pages !== undefined ? [fmt(t.paid.pages, { n: pages })] : []),
    fmt(t.paid.cost, { cost: estimate.total > 0 ? formatTwdFirst(estimate.total, estimate.currency) : avatarProviderId === "local" && type === "generate_avatar" ? t.paid.freeLocal : t.paid.free }),
    ...estimateLines(estimate).map((l) => `・${l}`),
    fmt(t.paid.wait, { wait: formatWait(wait) }),
  ];
  const notes = [isForced(req) ? t.paid.forcedNote : "", wait > 90 ? t.paid.longNote : ""].filter(Boolean);
  return {
    title: fmt(t.paid.title, { job: t.jobs.types[type] }),
    lines,
    note: notes.join(" "),
    confirmLabel: fmt(t.paid.start, { cost: twdShort(estimate.total, estimate.currency) }),
  };
}

/** "約 NT$321" / "不到 NT$1" / "免費", for buttons. */
export function twdShort(amount: number, currency = "USD"): string {
  if (amount <= 0) return t.paid.free;
  if (currency !== "USD") return formatTwdFirst(amount, currency);
  const twd = amount * TWD_PER_USD;
  return twd < 1 ? "不到 NT$1" : `約 NT$${Math.round(twd).toLocaleString("zh-TW")}`;
}

/** Without an estimate (API error) avatars and forced reruns still must not start unasked. */
export function needsConfirmWithoutEstimate(req: EnqueueJobRequest): boolean {
  return req.type === "generate_avatar" || isForced(req);
}

export function unknownEstimateContent(type: EstimateType, avatarProviderId?: string) {
  const price = type === "generate_avatar" && avatarProviderId === "heygen" ? t.paid.unknownHeygen : t.paid.unknownGeneric;
  return {
    title: fmt(t.paid.title, { job: t.jobs.types[type] }),
    lines: [t.paid.unknown, price],
    note: t.paid.unknownNote,
    confirmLabel: t.paid.startAnyway,
  };
}
