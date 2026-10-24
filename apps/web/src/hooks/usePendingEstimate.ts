import { useEffect, useState } from "react";
import type { CostEstimate } from "@lvs/shared";
import { useApi } from "../api/context";
import type { EstimateType } from "../api/types";

/**
 * What one job type would cost for the pages it would really process (scope "pending"), for
 * labelling buttons such as 「產生語音（不到 NT$1）」. Re-fetched when `revision` changes.
 */
export function usePendingEstimate(projectId: string | undefined, type: EstimateType | undefined, revision = ""): CostEstimate | undefined {
  const api = useApi();
  const [estimate, setEstimate] = useState<{ key: string; value: CostEstimate }>();
  const key = `${projectId}:${type}:${revision}`;
  useEffect(() => {
    if (!projectId || !type) return;
    let alive = true;
    api.getEstimate(projectId, type, { scope: "pending" }).then(
      (value) => alive && setEstimate({ key, value }),
      () => alive && setEstimate(undefined),
    );
    return () => {
      alive = false;
    };
  }, [api, projectId, type, key]);
  return estimate?.key === key ? estimate.value : undefined;
}
