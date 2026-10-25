import { useEffect, useState } from "react";
import type { CostEstimate } from "@lvs/shared";
import { useApi } from "../api/context";
import type { EstimateType } from "../api/types";

/**
 * What one job type would cost for the pages it would really process (scope "pending"), for
 * labelling buttons such as 「產生語音（不到 NT$1）」. Re-fetched when `revision` changes.
 */
export function usePendingEstimate(
  projectId: string | undefined,
  type: EstimateType | undefined,
  revision = "",
  /** "all": the price of redoing every page (a forced rerun). */
  scope: "pending" | "all" = "pending",
  /** Only these pages (e.g. redoing one page's avatar). */
  sceneIds?: string[],
  /** Only the answer for exactly this `revision` (no older one while the new one loads). */
  exact = false,
): CostEstimate | undefined {
  const api = useApi();
  const [estimate, setEstimate] = useState<{ key: string; base: string; value: CostEstimate }>();
  const ids = sceneIds?.join(",") ?? "";
  // Same question (project, job, scope) with newer inputs: keep showing the last answer until the
  // new one arrives, so a price on a button does not blink out every time a page finishes.
  // (Page-specific questions — e.g. one page's redo price — include the pages in the question.)
  const base = `${projectId}:${type}:${scope}:${ids}`;
  const key = `${base}:${revision}`;
  useEffect(() => {
    if (!projectId || !type) return;
    let alive = true;
    api.getEstimate(projectId, type, { scope, ...(ids ? { sceneIds: ids.split(",") } : {}) }).then(
      (value) => alive && setEstimate({ key, base, value }),
      () => alive && setEstimate(undefined),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, type, scope, ids, key, base]);
  return estimate?.key === key || (!exact && estimate?.base === base) ? estimate.value : undefined;
}
