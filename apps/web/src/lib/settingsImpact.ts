import type { ProjectDetail, Scene } from "@lvs/shared";

/** Scenes in deck order whose slide is not hidden. */
export function visibleScenes(detail: Pick<ProjectDetail, "scenes" | "slides">): Scene[] {
  const hidden = new Set(detail.slides.filter((s) => s.hidden).map((s) => s.id));
  return [...detail.scenes].filter((s) => !hidden.has(s.slideId)).sort((a, b) => a.index - b.index);
}

/**
 * The values `source` holds at the paths `shape` sets — the patch that undoes `shape`.
 * Leaves that `source` lacks become `undefined`, which the API's patch merge ignores.
 */
export function pickLike(shape: Record<string, unknown>, source: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    const cur = source?.[k];
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = pickLike(v as Record<string, unknown>, cur as Record<string, unknown> | undefined);
    else out[k] = cur;
  }
  return out;
}

/** "2、4–6" from page numbers (1-based). */
export function pageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join("、");
}
