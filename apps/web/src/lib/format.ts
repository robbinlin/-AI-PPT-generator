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
  // Three decimals only where two would read as US$0.00 (e.g. US$0.004 of speech).
  const digits = amount > 0 && amount < 0.1 ? 3 : 2;
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

interface SavePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName: string;
    id?: string;
    startIn?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
}

/** Whether the browser can ask where to save (Chrome/Edge); elsewhere files go to Downloads. */
export function canChooseSaveLocation(): boolean {
  return typeof window !== "undefined" && typeof (window as SavePickerWindow).showSaveFilePicker === "function";
}

/**
 * Asks where to save `filename` and streams `source` there; falls back to a normal download when
 * the browser has no save dialog. Must be called straight from a click (the dialog needs it).
 */
export async function saveFileAs(
  source: Blob | string | (() => Promise<Blob>),
  filename: string,
  type: { description: string; mime: string },
  /** Called once the location is chosen, before the (possibly long) copy starts. */
  onStart?: () => void,
): Promise<"saved" | "cancelled" | "downloaded"> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) {
    downloadFile(typeof source === "function" ? await source() : source, filename);
    return "downloaded";
  }
  const ext = filename.slice(filename.lastIndexOf("."));
  let handle;
  try {
    handle = await picker({
      suggestedName: filename,
      id: "lvs-export", // the dialog reopens in the folder chosen last time
      startIn: ext === ".mp4" ? "videos" : "documents",
      types: [{ description: type.description, accept: { [type.mime]: [ext] } }],
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return "cancelled";
    throw err;
  }
  const writable = await handle.createWritable();
  onStart?.();
  let data: Blob | string;
  let res: Response | undefined;
  try {
    data = typeof source === "function" ? await source() : source;
    if (typeof data === "string") res = await fetch(data);
  } catch (err) {
    // Nothing written: discard what we can. The browser may already have created the chosen file
    // (empty), so say so rather than pretend nothing is there.
    await writable.abort().catch(() => undefined);
    throw new Error(`${(err as Error).message || String(err)}（選擇的檔案可能已變成空檔，可刪除後再試一次）`);
  }
  if (res) {
    if (!res.ok || !res.body) {
      await writable.abort().catch(() => undefined);
      throw new Error(`下載失敗（HTTP ${res.status}；選擇的檔案可能已變成空檔，可刪除後再試一次）`);
    }
    await res.body.pipeTo(writable); // aborts the file itself if the transfer breaks
  } else {
    await (data as Blob).stream().pipeTo(writable);
  }
  return "saved";
}

/** Rough rate for showing NT$ next to provider prices (they bill in USD). */
export const TWD_PER_USD = 32;

/** "US$1.25（約 NT$40）"; tiny amounts read as "不到 NT$1". */
export function formatCostTwd(amount: number, currency = "USD"): string {
  const base = formatCost(amount, currency);
  if (currency !== "USD" || amount <= 0) return base;
  const twd = amount * TWD_PER_USD;
  return `${base}（${twd < 1 ? "不到 NT$1" : `約 NT$${Math.round(twd).toLocaleString("zh-TW")}`}）`;
}

/** NT$ first for Taiwanese readers: "約 NT$321（US$10.02）", "不到 NT$1（US$0.004）", "免費". */
export function formatTwdFirst(amount: number, currency = "USD"): string {
  if (amount <= 0) return "免費";
  const base = formatCost(amount, currency);
  if (currency !== "USD") return base;
  const twd = amount * TWD_PER_USD;
  return `${twd < 1 ? "不到 NT$1" : `約 NT$${Math.round(twd).toLocaleString("zh-TW")}`}（${base}）`;
}

/** "約 3 分鐘" / "不到 1 分鐘" / "約 1 小時 10 分鐘" for waits. */
export function formatWait(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return "不到 1 分鐘";
  if (min < 60) return `約 ${min} 分鐘`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `約 ${h} 小時 ${m} 分鐘` : `約 ${h} 小時`;
}

/**
 * Remaining time from elapsed time and progress, once there is enough progress to extrapolate.
 * Returns null while the estimate would be noise (under 5% or under 10 s in).
 */
export function remainingSec(startedAt: string | undefined, progress: number, now: number = Date.now()): number | null {
  if (!startedAt || progress < 0.05 || progress >= 1) return null;
  const elapsed = (now - Date.parse(startedAt)) / 1000;
  if (!(elapsed >= 10)) return null;
  return (elapsed * (1 - progress)) / progress;
}
