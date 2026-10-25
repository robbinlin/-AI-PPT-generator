import type { CostEstimate, EnqueueJobRequest } from "@lvs/shared";
import type { EstimateType } from "../api/types";
import { fmt, t } from "../i18n";
import { formatTwdFirst, formatWait, TWD_PER_USD } from "./format";

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
    case "generate_avatar": {
      // Reused clips are only relinked; the wait is for the pages really made.
      const made = Math.max(0, pages - (estimate.reusedSceneCount ?? 0));
      return avatarProviderId === "local" ? 20 + seconds * 3 : made * 90 + seconds * 6;
    }
    case "render_video":
      return 20 + seconds * 0.5;
    case "translate_script":
      return pages * 4;
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
  // Input and output tokens are one thing to a lecturer (writing the scripts): one line, one price.
  const tokens = estimate.lines.filter((l) => l.unit === "tokens_in" || l.unit === "tokens_out");
  if (tokens.length) {
    const cost = tokens.reduce((n, l) => n + l.estimatedCost, 0);
    out.push(`${estimate.sceneCount ? fmt(t.paid.lineScriptPages, { n: estimate.sceneCount }) : t.paid.lineScript}：${formatTwdFirst(cost)}`);
  }
  for (const line of estimate.lines) {
    if (line.unit === "tokens_in" || line.unit === "tokens_out") continue;
    const q = Math.round(line.quantity).toLocaleString("zh-TW");
    const what =
      line.unit === "chars"
        ? fmt(t.paid.lineSpeech, { n: q })
        : line.unit === "avatar_seconds"
          ? fmt(t.paid.lineAvatar, { n: q })
          : null;
    if (what) out.push(`${what}：${formatTwdFirst(line.estimatedCost)}`);
  }
  return out;
}

/** Finished presenter clips a forced speech/script rerun would make outdated (new audio = new clip). */
export interface AvatarLoss {
  pages: number;
  /** Cost of making those clips again, when it could be estimated. */
  redo?: CostEstimate;
}

export function confirmContent(type: EstimateType, req: EnqueueJobRequest, estimate: CostEstimate, avatarProviderId?: string, loss?: AvatarLoss) {
  const pages = estimate.sceneCount;
  const wait = estimateWaitSec(type, estimate, avatarProviderId);
  const lines = [
    ...(pages !== undefined ? [fmt(t.paid.pages, { n: pages })] : []),
    ...(estimate.reusedSceneCount ? [fmt(t.paid.reusedAvatars, { n: estimate.reusedSceneCount })] : []),
    fmt(t.paid.cost, { cost: estimate.total > 0 ? formatTwdFirst(estimate.total, estimate.currency) : avatarProviderId === "local" && type === "generate_avatar" ? t.paid.freeLocal : t.paid.free }),
    ...estimateLines(estimate).map((l) => `・${l}`),
    fmt(t.paid.wait, { wait: formatWait(wait) }),
  ];
  if (loss && loss.pages > 0) {
    lines.push(
      fmt(t.paid.avatarLoss, {
        n: loss.pages,
        cost: loss.redo && loss.redo.total > 0 ? fmt(t.paid.avatarLossCost, { cost: twdShort(loss.redo.total, loss.redo.currency) }) : "",
      }),
    );
  }
  const notes = [isForced(req) ? t.paid.forcedNote : "", wait > 90 ? t.paid.longNote : ""].filter(Boolean);
  // 「全部做完再匯出」: say that the video follows, and how it will be exported.
  const then = "thenRender" in req ? req.thenRender : undefined;
  if (then) {
    lines.push(
      fmt(t.paid.thenRender, {
        preset: then.preset === "preview_540p" ? "540p" : "1080p",
        subtitles: then.burnSubtitles === false ? t.paid.thenRenderNoSubs : t.paid.thenRenderSubs,
      }),
    );
  }
  return {
    title: fmt(t.paid.title, { job: t.jobs.types[type] }),
    lines,
    note: notes.join(" "),
    confirmLabel: fmt(then ? t.paid.startThenRender : t.paid.start, { cost: twdShort(estimate.total, estimate.currency) }),
    ...(loss && loss.pages > 0 ? { danger: true } : {}),
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
