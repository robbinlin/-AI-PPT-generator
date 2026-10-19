import { describe, expect, it, vi } from "vitest";
import { geminiErrorStatus, withGeminiRetry } from "../src/gemini-retry.js";

const apiError = (code: number, message = "x") => Object.assign(new Error(JSON.stringify({ error: { code, message } })), { status: code });

describe("withGeminiRetry", () => {
  it("retries 503 on the same model then falls back to the next model", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const p = withGeminiRetry(["a", "b"], async (m) => {
      calls.push(m);
      if (m === "a") throw apiError(503, "high demand");
      return "ok";
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(calls).toEqual(["a", "a", "a", "a", "b"]);
    vi.useRealTimers();
  });
  it("does not retry non-transient errors", async () => {
    const calls: string[] = [];
    await expect(withGeminiRetry(["a", "b"], async (m) => { calls.push(m); throw apiError(404, "no model"); })).rejects.toThrow();
    expect(calls).toEqual(["a"]);
  });
  it("skips to the fallback model on a daily quota 429", async () => {
    const calls: string[] = [];
    await expect(withGeminiRetry(["a", "b"], async (m) => { calls.push(m); if (m === "a") throw apiError(429, "GenerateRequestsPerDayPerProjectPerModel-FreeTier"); return 1; })).resolves.toBe(1);
    expect(calls).toEqual(["a", "b"]);
  });
  it("extracts the status from SDK error shapes", () => {
    expect(geminiErrorStatus({ status: 503 })).toBe(503);
    expect(geminiErrorStatus(new Error('{"error":{"code":429,"message":"q"}}'))).toBe(429);
    expect(geminiErrorStatus(new Error("boom"))).toBeUndefined();
  });
});
