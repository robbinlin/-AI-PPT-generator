import { describe, expect, it } from "vitest";
import { fetchWithRetry, HttpError } from "../src/http.js";

function fakeFetch(responses: Array<{ status: number; body?: string }>): { fetch: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const f = (async () => {
    const r = responses[Math.min(state.calls, responses.length - 1)]!;
    state.calls += 1;
    return new Response(r.body ?? "", { status: r.status });
  }) as unknown as typeof fetch;
  return { fetch: f, get calls() { return state.calls; } };
}

describe("fetchWithRetry", () => {
  it("retries 429 then succeeds", async () => {
    const ff = fakeFetch([{ status: 429 }, { status: 503 }, { status: 200, body: "ok" }]);
    const res = await fetchWithRetry("https://x.test/a?key=secret", { fetchImpl: ff.fetch, retryBaseMs: 0 });
    expect(await res.text()).toBe("ok");
    expect(ff.calls).toBe(3);
  });
  it("does not retry 400 and redacts the query string", async () => {
    const ff = fakeFetch([{ status: 400, body: "bad" }]);
    await expect(fetchWithRetry("https://x.test/a?key=secret", { fetchImpl: ff.fetch, retryBaseMs: 0 })).rejects.toThrow(HttpError);
    try {
      await fetchWithRetry("https://x.test/a?key=secret", { fetchImpl: ff.fetch, retryBaseMs: 0 });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
      expect((e as HttpError).status).toBe(400);
    }
  });
  it("gives up after maxRetries", async () => {
    const ff = fakeFetch([{ status: 500 }]);
    await expect(fetchWithRetry("https://x.test/a", { fetchImpl: ff.fetch, retryBaseMs: 0, maxRetries: 2 })).rejects.toThrow(/HTTP 500/);
    expect(ff.calls).toBe(3);
  });
});
