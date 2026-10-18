import type { ApiClient } from "./types";

interface Entry {
  url: string;
  expiresAt: number;
}

/** Re-fetch a signed URL when it has less than this long to live. */
const REFRESH_MARGIN_MS = 30_000;
const MAX_ENTRIES = 500;

/**
 * Resolves asset ids to (signed) URLs through `GET /projects/:id/assets/:assetId/url`,
 * caching each URL until shortly before it expires and de-duplicating concurrent lookups.
 */
export class AssetUrlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly api: Pick<ApiClient, "getAssetUrl">,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Synchronous lookup of a still-valid cached URL. */
  peek(assetId: string): string | undefined {
    const e = this.entries.get(assetId);
    return e && e.expiresAt - REFRESH_MARGIN_MS > this.now() ? e.url : undefined;
  }

  get(projectId: string, assetId: string): Promise<string> {
    const cached = this.peek(assetId);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(assetId);
    if (pending) return pending;
    const p = this.api
      .getAssetUrl(projectId, assetId)
      .then(({ url, expiresAt }) => {
        const exp = Date.parse(expiresAt);
        if (this.entries.size >= MAX_ENTRIES) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(assetId, { url, expiresAt: Number.isFinite(exp) ? exp : this.now() + 5 * 60_000 });
        return url;
      })
      .finally(() => this.inflight.delete(assetId));
    this.inflight.set(assetId, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
