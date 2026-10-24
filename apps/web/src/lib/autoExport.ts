/**
 * Videos already saved from this browser, so the export button stops pointing at them.
 * (「全部做完再匯出」 is chained on the server: see `thenRender` on the job payload.)
 */

// ------------------------------------------------------------ downloaded videos --

const KEY = "lvs:downloaded-videos";

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remembers that this video was saved, so the export button stops pointing at it. */
export function markDownloaded(assetId: string): void {
  try {
    const list = read().filter((x) => x !== assetId);
    list.push(assetId);
    localStorage.setItem(KEY, JSON.stringify(list.slice(-200)));
    window.dispatchEvent(new Event(KEY));
  } catch {
    // Storage blocked: the reminder just stays on.
  }
}

export function wasDownloaded(assetId: string): boolean {
  return read().includes(assetId);
}

export const DOWNLOADED_EVENT = KEY;
