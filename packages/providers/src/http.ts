/**
 * Minimal fetch wrapper used by every REST provider: timeout, retry on 429/5xx
 * with exponential backoff, JSON helpers. Keys are passed via headers by the
 * caller and never logged.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} from ${redact(url)}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export interface FetchOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  maxRetries?: number;
  /** Base delay for backoff in ms (doubles each attempt). Tests set this to 0. */
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function redact(url: string): string {
  // Strip query strings so API keys passed as query params never reach logs.
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i) + "?…";
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 60_000, maxRetries = 3, retryBaseMs = 500, fetchImpl = fetch, ...init } = opts;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        attempt += 1;
        await sleep(backoff(attempt, retryBaseMs, res.headers.get("retry-after")));
        continue;
      }
      throw new HttpError(res.status, url, body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Network error or abort: retry a limited number of times.
      if (attempt < maxRetries) {
        attempt += 1;
        await sleep(backoff(attempt, retryBaseMs, null));
        continue;
      }
      throw new Error(`request to ${redact(url)} failed after ${attempt + 1} attempts: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}

function backoff(attempt: number, base: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return base * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
