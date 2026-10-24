/**
 * Free, read-only calls that tell whether a pasted API key works, so a typo is caught on save
 * instead of as a failed (and possibly half-paid) job later. Nothing here costs credits.
 */
const CHECKS: Record<string, (apiKey: string) => { url: string; headers: Record<string, string> }> = {
  elevenlabs: (k) => ({ url: "https://api.elevenlabs.io/v2/voices?page_size=1&include_total_count=false", headers: { "xi-api-key": k } }),
  heygen: (k) => ({ url: "https://api.heygen.com/v3/avatars/looks?ownership=private&limit=1", headers: { "x-api-key": k } }),
  gemini: (k) => ({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": k } }),
  anthropic: (k) => ({ url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": k, "anthropic-version": "2023-06-01" } }),
};

/**
 * "invalid" only when the vendor answers 401/403 (or Google's 400 API_KEY_INVALID). Network
 * trouble, rate limits or a vendor without a check give "unknown": the key is saved anyway.
 */
export async function checkProviderKey(providerId: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<"ok" | "invalid" | "unknown"> {
  const make = CHECKS[providerId];
  if (!make) return "unknown";
  const { url, headers } = make(apiKey);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "invalid";
    if (res.status === 400 && providerId === "gemini" && /API_KEY_INVALID|API key not valid/i.test(await res.text())) return "invalid";
    return "unknown";
  } catch {
    return "unknown";
  }
}
