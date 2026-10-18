import { fmt, t } from "../i18n";

/** 75 → "1:15"; 3725 → "1:02:05". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t.relTime.justNow;
  if (min < 60) return fmt(t.relTime.minutes, { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return fmt(t.relTime.hours, { n: h });
  const d = Math.floor(h / 24);
  if (d < 14) return fmt(t.relTime.days, { n: d });
  return new Date(iso).toLocaleDateString("zh-TW");
}

export function formatCost(amount: number, currency = "USD"): string {
  const digits = amount > 0 && amount < 1 ? 3 : 2;
  try {
    return new Intl.NumberFormat("zh-TW", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(digits)}`;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Triggers a browser download for a Blob or URL. */
export function downloadFile(source: Blob | string, filename: string): void {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof source !== "string") setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
