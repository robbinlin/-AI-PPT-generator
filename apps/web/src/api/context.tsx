import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AssetUrlCache } from "./assetUrls";
import { HttpApiClient, apiBaseUrl } from "./client";
import type { ApiClient } from "./types";

export interface ApiEnv {
  client: ApiClient;
  assetUrls: AssetUrlCache;
  /** Why the mock is in use, if it is: requested explicitly or the API was unreachable. */
  mockReason: "requested" | "unreachable" | null;
  baseUrl: string;
}

const ApiContext = createContext<ApiEnv | null>(null);

export function makeEnv(client: ApiClient, mockReason: ApiEnv["mockReason"], baseUrl: string): ApiEnv {
  return { client, assetUrls: new AssetUrlCache(client), mockReason, baseUrl };
}

async function createMock(): Promise<ApiClient> {
  // Loaded on demand so the fixture code stays out of the main bundle when the API is up.
  const { MockApiClient } = await import("./mock");
  return new MockApiClient({ latencyMs: 120 });
}

/** Chooses the real API or the mock: VITE_API_MOCK=1 forces the mock; an unreachable API falls back to it. */
export async function resolveApiEnv(): Promise<ApiEnv> {
  const baseUrl = apiBaseUrl();
  if (import.meta.env.VITE_API_MOCK === "1" || import.meta.env.VITE_API_MOCK === "true") {
    return makeEnv(await createMock(), "requested", baseUrl);
  }
  const http = new HttpApiClient(baseUrl);
  if (await http.ping()) return makeEnv(http, null, baseUrl);
  return makeEnv(await createMock(), "unreachable", baseUrl);
}

export function ApiProvider({ env, children }: { env: ApiEnv; children: ReactNode }) {
  return <ApiContext.Provider value={env}>{children}</ApiContext.Provider>;
}

export function useApiEnv(): ApiEnv {
  const env = useContext(ApiContext);
  if (!env) throw new Error("useApiEnv must be used inside <ApiProvider>");
  return env;
}

export function useApi(): ApiClient {
  return useApiEnv().client;
}

/** Resolves an asset id to a URL (undefined while loading or when there is no asset). */
export function useAssetUrl(projectId: string | undefined, assetId: string | undefined): string | undefined {
  const { assetUrls } = useApiEnv();
  const [resolved, setResolved] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    if (!projectId || !assetId || assetUrls.peek(assetId)) return;
    let alive = true;
    assetUrls
      .get(projectId, assetId)
      .then((url) => {
        if (alive) setResolved({ id: assetId, url });
      })
      .catch(() => {
        /* missing asset: leave the placeholder */
      });
    return () => {
      alive = false;
    };
  }, [projectId, assetId, assetUrls]);

  if (!assetId) return undefined;
  return assetUrls.peek(assetId) ?? (resolved?.id === assetId ? resolved.url : undefined);
}
