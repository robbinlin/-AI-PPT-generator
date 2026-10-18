import { useEffect, useState } from "react";
import type { CostEstimate } from "@lvs/shared";
import { useApi } from "../api/context";
import type { EstimateType } from "../api/types";

export interface CombinedEstimate {
  total: number;
  currency: string;
  parts: Partial<Record<EstimateType, CostEstimate>>;
}

/**
 * Remaining spend for speech (+ avatar when enabled), re-fetched (debounced) whenever `revision`
 * changes — callers pass something that changes with scene states / scripts.
 */
export function useCostEstimate(
  projectId: string | undefined,
  avatarEnabled: boolean,
  revision: string,
): CombinedEstimate | null {
  const api = useApi();
  const [estimate, setEstimate] = useState<CombinedEstimate | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const timer = setTimeout(() => {
      const types: EstimateType[] = avatarEnabled ? ["synthesize_speech", "generate_avatar"] : ["synthesize_speech"];
      Promise.all(types.map((type) => api.getEstimate(projectId, type).then((e) => [type, e] as const)))
        .then((results) => {
          if (!alive) return;
          const parts: CombinedEstimate["parts"] = {};
          let total = 0;
          for (const [type, e] of results) {
            parts[type] = e;
            total += e.total;
          }
          setEstimate({ total, currency: results[0]?.[1].currency ?? "USD", parts });
        })
        .catch(() => alive && setEstimate(null));
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, projectId, avatarEnabled, revision]);

  return estimate;
}
