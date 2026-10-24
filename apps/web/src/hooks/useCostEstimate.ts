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
 * What it would cost to bring every page up to date (scope "pending": pages that are missing,
 * stale or failed). With avatars on, the avatar estimate already includes the speech its pages
 * need, so speech is not added again. Re-fetched (debounced) whenever `revision` changes.
 */
export function useCostEstimate(
  projectId: string | undefined,
  avatarEnabled: boolean,
  revision: string,
  /** Pages without a script: the only script work counted (outdated scripts are optional). */
  missingScriptIds: string[] = [],
): CombinedEstimate | null {
  const api = useApi();
  const [estimate, setEstimate] = useState<CombinedEstimate | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const timer = setTimeout(() => {
      const types: EstimateType[] = [...(missingScriptIds.length ? (["generate_script"] as const) : []), avatarEnabled ? "generate_avatar" : "synthesize_speech"];
      Promise.all(
        types.map((type) =>
          api.getEstimate(projectId, type, { scope: "pending", ...(type === "generate_script" ? { sceneIds: missingScriptIds } : {}) }).then((e) => [type, e] as const),
        ),
      )
        .then((results) => {
          if (!alive) return;
          const parts: CombinedEstimate["parts"] = {};
          let total = 0;
          for (const [type, e] of results) {
            if (e.sceneCount === 0) continue;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, avatarEnabled, revision, missingScriptIds.join(",")]);

  return estimate;
}
