import type { DerivedStatus, Scene } from "@lvs/shared";
import { t } from "../../i18n";

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

export function statusLabel(field: StatusField, status: DerivedStatus): string {
  return `${t.status[field]}：${t.status[status]}`;
}

/** Four small dots (講稿/語音/人像/字幕) coloured by each derived asset's state. */
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
            className={`size-2 rounded-full ${statusDotClass[state.status]}`}
          />
        );
      })}
    </ul>
  );
}

/** Legend shown under the page list. */
export function StatusLegend() {
  const statuses: DerivedStatus[] = ["ready", "generating", "stale", "failed", "missing"];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
      <span>{STATUS_FIELDS.map((f) => t.status[f]).join(" · ")}</span>
      {statuses.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={`size-1.5 rounded-full ${statusDotClass[s]}`} aria-hidden />
          {t.status[s]}
        </span>
      ))}
    </div>
  );
}
