import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../src/registry.js";

describe("registry", () => {
  it("lists providers by kind", () => {
    const ids = (k: "llm" | "tts" | "avatar") => defaultRegistry.listProviders(k).map((p) => p.id).sort();
    expect(ids("llm")).toEqual(["anthropic", "gemini", "mock"]);
    expect(ids("tts")).toEqual(["elevenlabs", "gemini", "mock"]);
    expect(ids("avatar")).toEqual(["heygen", "mock"]);
    expect(defaultRegistry.listProviders()).toHaveLength(8);
  });
  it("creates mocks without keys and refuses keyed providers without one", () => {
    expect(defaultRegistry.createTts("mock").id).toBe("mock");
    expect(() => defaultRegistry.createLlm("gemini")).toThrow(/API key/);
    expect(defaultRegistry.createLlm("anthropic", { apiKey: "k" }).defaultModel).toBe("claude-opus-5-5");
    expect(() => defaultRegistry.createAvatar("nope")).toThrow(/unknown/);
  });
});
