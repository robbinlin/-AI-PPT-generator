import { describe, expect, it } from "vitest";
// The launcher is plain ESM outside any package; importing it does not start anything.
// @ts-expect-error no type declarations for the script
import { classify } from "../../../scripts/dev-all.mjs";

describe("pnpm dev: what reaches the terminal", () => {
  it("shows API warnings and errors, keeps request logs in the file", () => {
    expect(classify("api", JSON.stringify({ level: 30, msg: "incoming request" }))).toBeNull();
    expect(classify("api", JSON.stringify({ level: 40, msg: "job failed, retrying", err: "HTTP 503" }))).toEqual({ level: "warn", text: "job failed, retrying：HTTP 503" });
    expect(classify("api", JSON.stringify({ level: 50, msg: "job failed", err: { message: "boom" } }))).toEqual({ level: "error", text: "job failed：boom" });
    expect(classify("api", "◇ injected env (15) from ../../.env")).toBeNull();
    expect(classify("api", "[api] uncaught exception: Error: listen EADDRINUSE")?.level).toBe("error");
  });
  it("shows whole Python tracebacks and warnings, hides access logs", () => {
    const state = {};
    expect(classify("tts", 'INFO:     127.0.0.1:54089 - "GET /health HTTP/1.1" 200 OK', state)).toBeNull();
    expect(classify("tts", "2026-10-22 WARNING lvs_tts: whisper on cuda timed out", state)?.level).toBe("warn");
    const lines = ["Traceback (most recent call last):", '  File "x.py", line 1, in <module>', "    raise OSError()", "OSError: Reference audio is outside the 3-10 second range", "INFO:     done"];
    expect(lines.map((l) => classify("tts", l, state)?.level ?? null)).toEqual(["error", "error", "error", "error", null]);
  });
  it("only shows Vite lines that report a problem", () => {
    expect(classify("web", "  ➜  Local:   http://localhost:5173/")).toBeNull();
    expect(classify("web", "[vite] Internal server error: Failed to resolve import")?.level).toBe("error");
  });
});
