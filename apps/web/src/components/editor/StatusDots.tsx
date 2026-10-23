import type { DerivedStatus, Scene } from "@lvs/shared";
import { fmt, t } from "../../i18n";

export const STATUS_FIELDS = ["script", "audio", "avatar", "subtitle"] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];

export const statusDotClass: Record<DerivedStatus, string> = {
  missing: "bg-neutral-600",
  queued: "bg-sky-800 ring-1 ring-sky-400/60",
  generating: "bg-sky-400 animate-pulse",
  ready: "bg-emerald-500",
  stale: "bg-amber-400",
  failed: "bg-rose-500",
};

/** Chip look per status: colour plus a distinct border style, so it does not rely on hue alone. */
const chipClass: Record<DerivedStatus, string> = {
  missing: "border-neutral-600 border-dashed text-neutral-400",
  queued: "border-sky-400/70 text-sky-200",
  generating: "border-sky-400 bg-sky-500/20 text-sky-100 animate-pulse",
  ready: "border-emerald-500/70 bg-emerald-500/20 text-emerald-200",
  stale: "border-amber-400 bg-amber-400/25 text-amber-100 border-[1.5px]",
  failed: "border-rose-500 bg-rose-500/30 text-rose-100 border-[1.5px]",
};

export function statusLabel(field: StatusField, status: DerivedStatus): string {
  return `${t.status[field]}：${t.status[status]}`;
}

/** Four labelled chips (講/語/人/字), each showing its asset's state by colour and border. */
export function StatusDots({ scene }: { scene: Scene }) {
  return (
    <ul className="flex items-center gap-1" aria-label={t.pageList.title}>
      {STATUS_FIELDS.map((field) => {
        const state = scene[field];
        const label = statusLabel(field, state.status) + (state.error ? ` (${state.error})` : "");
        return (
          <li
            key={field}
            role="img"
            aria-label={label}
            title={label}
            data-field={field}
            data-status={state.status}
            className={`flex h-4 min-w-4 items-center justify-center rounded border px-0.5 text-[10px] leading-none font-medium ${chipClass[state.status]}`}
          >
            {t.status[field].slice(0, 1)}
          </li>
        );
      })}
    </ul>
  );
}

/** One line in words for the most urgent state, e.g. "語音、人像需更新". Null when all is fine. */
export function statusSummary(scene: Scene): { text: string; tone: "error" | "warn" | "muted" } | null {
  const fields = (status: DerivedStatus) => STATUS_FIELDS.filter((f) => scene[f].status === status).map((f) => t.status[f]);
  const failed = fields("failed");
  if (failed.length) return { text: fmt(t.pageList.failed, { list: failed.join("、") }), tone: "error" };
  const stale = fields("stale");
  if (stale.length) return { text: fmt(t.pageList.needsWork, { list: stale.join("、") }), tone: "warn" };
  const missing = fields("missing");
  if (missing.length && missing.length < STATUS_FIELDS.length) return { text: fmt(t.pageList.notMade, { list: missing.join("、") }), tone: "muted" };
  return null;
}

export function StatusSummary({ scene }: { scene: Scene }) {
  const summary = statusSummary(scene);
  if (!summary) return null;
  const color = summary.tone === "error" ? "text-rose-300" : summary.tone === "warn" ? "text-amber-200" : "text-neutral-400";
  return <p className={`mt-1 text-[11px] leading-snug ${color}`}>{summary.text}</p>;
}

/** Legend shown under the page list. */
export function StatusLegend() {
  const statuses: DerivedStatus[] = ["ready", "generating", "stale", "failed", "missing"];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-400">
      <span>{STATUS_FIELDS.map((f) => `${t.status[f].slice(0, 1)}＝${t.status[f]}`).join("　")}</span>
      {statuses.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={`inline-block size-3 rounded-sm border ${chipClass[s]}`} aria-hidden />
          {t.status[s]}
        </span>
      ))}
    </div>
  );
}
