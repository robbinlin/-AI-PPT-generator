import { describe, expect, it } from "vitest";
import { checkProviderKey } from "../src/services/keyCheck.js";

const answer = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("checkProviderKey", () => {
  it("calls a key the vendor refuses invalid", async () => {
    expect(await checkProviderKey("elevenlabs", "bad", answer(401))).toBe("invalid");
    expect(await checkProviderKey("heygen", "bad", answer(403))).toBe("invalid");
    expect(await checkProviderKey("gemini", "bad", answer(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'))).toBe("invalid");
  });

  it("accepts a working key and never blocks on doubt", async () => {
    expect(await checkProviderKey("anthropic", "good", answer(200, "{}"))).toBe("ok");
    expect(await checkProviderKey("elevenlabs", "k", answer(429))).toBe("unknown");
    expect(await checkProviderKey("yating", "k", answer(401))).toBe("unknown");
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkProviderKey("heygen", "k", offline)).toBe("unknown");
  });

  it("sends the key in a header, never in the URL", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await checkProviderKey("gemini", "secret-key", spy);
    expect(seen?.url).not.toContain("secret-key");
    expect(seen?.headers["x-goog-api-key"]).toBe("secret-key");
  });
});
