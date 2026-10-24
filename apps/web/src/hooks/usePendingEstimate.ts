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
): CostEstimate | undefined {
  const api = useApi();
  const [estimate, setEstimate] = useState<{ key: string; value: CostEstimate }>();
  const ids = sceneIds?.join(",") ?? "";
  const key = `${projectId}:${type}:${scope}:${ids}:${revision}`;
  useEffect(() => {
    if (!projectId || !type) return;
    let alive = true;
    api.getEstimate(projectId, type, { scope, ...(ids ? { sceneIds: ids.split(",") } : {}) }).then(
      (value) => alive && setEstimate({ key, value }),
      () => alive && setEstimate(undefined),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, type, scope, ids, key]);
  return estimate?.key === key ? estimate.value : undefined;
}
