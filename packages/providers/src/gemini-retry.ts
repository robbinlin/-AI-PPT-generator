/**
 * Shared retry policy for Gemini calls: transient 503/500/429 errors are retried with
 * exponential backoff, then the next fallback model is tried. Daily-quota 429s skip
 * straight to the fallback model instead of hammering a dead quota.
 */
export const GEMINI_MAX_ATTEMPTS = 4;

export function geminiErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; message?: string };
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.code === "number") return e.code;
  const m = /"code":\s*(\d{3})/.exec(e?.message ?? "");
  return m ? Number(m[1]) : undefined;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function parseModelList(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Runs `call(model)` across `models` in order with retries; throws the last error. */
export async function withGeminiRetry<T>(models: string[], call: (model: string) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
      try {
        return await call(model);
      } catch (err) {
        lastErr = err;
        const status = geminiErrorStatus(err);
        if (!(status === 503 || status === 429 || status === 500)) throw err;
        if (status === 429 && /per.?day|PerDay/i.test(String(err))) {
          console.warn(`[gemini] ${model}: daily quota exhausted, trying the next model`);
          break;
        }
        if (attempt < GEMINI_MAX_ATTEMPTS - 1) {
          const wait = Math.min(30_000, 2_000 * 2 ** attempt) + Math.random() * 1_000;
          console.warn(`[gemini] ${model} returned ${status} (busy); retry ${attempt + 2}/${GEMINI_MAX_ATTEMPTS} in ${Math.round(wait / 1000)}s`);
          await sleep(wait);
        } else {
          console.warn(`[gemini] ${model} still failing after ${GEMINI_MAX_ATTEMPTS} attempts; trying the next model`);
        }
      }
    }
  }
  throw lastErr;
}
