import type { EnqueueJobRequest } from "@lvs/shared";

/**
 * "Make what's missing, then export": the export menu arms a render to start once a speech or
 * avatar job succeeds (VoAI-style one-click video). Cleared when that job fails or is cancelled.
 */
type RenderRequest = Extract<EnqueueJobRequest, { type: "render_video" }>;

const pending = new Map<string, RenderRequest>();

export function armAutoExport(jobId: string, render: RenderRequest): void {
  pending.set(jobId, render);
}

/** The render to start for a finished job, if one was armed (consumed once). */
export function takeAutoExport(jobId: string, status: string): RenderRequest | undefined {
  if (!pending.has(jobId)) return undefined;
  const req = pending.get(jobId);
  if (status === "succeeded" || status === "failed" || status === "cancelled") pending.delete(jobId);
  return status === "succeeded" ? req : undefined;
}

export function isAutoExportArmed(jobId: string | undefined): boolean {
  return !!jobId && pending.has(jobId);
}

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
