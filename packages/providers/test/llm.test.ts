import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAnthropicJsonParams, mapAnthropicJsonResponse } from "../src/llm/anthropic.js";
import { buildGeminiJsonCall, mapGeminiJsonResponse } from "../src/llm/gemini.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { extractJsonText, zodToProviderSchema } from "../src/jsonschema.js";

const Out = z.object({ title: z.string(), points: z.array(z.string()) });
const req = {
  system: "sys",
  prompt: "write",
  schema: Out,
  attachments: [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]), label: "slide 1" }],
};

describe("jsonschema", () => {
  it("strips $schema/default and closes objects", () => {
    const s = zodToProviderSchema(z.object({ a: z.string().default("x"), b: z.object({ c: z.number() }) }), { closedObjects: true, strip: ["default"] });
    expect(s.$schema).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('"default"');
    expect(s.additionalProperties).toBe(false);
    expect((s.properties as Record<string, Record<string, unknown>>).b!.additionalProperties).toBe(false);
  });
  it("extractJsonText handles fences and prose", () => {
    expect(extractJsonText('Sure!\n```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('Here: {"a":[1,2]} done')).toBe('{"a":[1,2]}');
    expect(extractJsonText('[1,2]')).toBe("[1,2]");
  });
});

describe("gemini llm mapping", () => {
  it("builds a JSON-mode call with attachments first", () => {
    const call = buildGeminiJsonCall(req);
    expect(call.model).toBe("gemini-2.5-pro");
    expect(call.config.responseMimeType).toBe("application/json");
    expect(call.config.systemInstruction).toBe("sys");
    expect(JSON.stringify(call.config.responseJsonSchema)).not.toContain("additionalProperties");
    const parts = call.contents[0]!.parts;
    expect(parts[0]).toEqual({ text: "[slide 1]" });
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "AQID" } });
    expect(parts.at(-1)).toEqual({ text: "write" });
  });
  it("maps a response with usage", () => {
    const r = mapGeminiJsonResponse(
      { text: '{"title":"T","points":["a"]}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, responseId: "r1" },
      req,
    );
    expect(r.data).toEqual({ title: "T", points: ["a"] });
    expect(r.usage).toEqual([
      { unit: "tokens_in", quantity: 10 },
      { unit: "tokens_out", quantity: 5 },
    ]);
    expect(r.providerRequestId).toBe("r1");
  });
  it("rejects schema-invalid output", () => {
    expect(() => mapGeminiJsonResponse({ text: '{"title":1}' }, req)).toThrow();
  });
});

describe("anthropic llm mapping", () => {
  it("builds structured-output params without forced tool use", () => {
    const p = buildAnthropicJsonParams(req);
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect((p as Record<string, unknown>).tool_choice).toBeUndefined();
    const content = p.messages[0]!.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(["text", "image", "text"]);
  });
  it("maps text content and usage, rejects refusals", () => {
    const r = mapAnthropicJsonResponse(
      { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: '{"title":"T","points":[]}' }], usage: { input_tokens: 3, output_tokens: 4 } },
      req,
    );
    expect(r.data.title).toBe("T");
    expect(r.usage[1]).toEqual({ unit: "tokens_out", quantity: 4 });
    expect(() => mapAnthropicJsonResponse({ stop_reason: "refusal", content: [] }, req)).toThrow(/refused/);
  });
});

describe("mock llm", () => {
  it("validates canned data against the schema and records calls", async () => {
    const llm = new MockLlmProvider(() => ({ title: "x", points: ["p"] }));
    const r = await llm.generateJson(req);
    expect(r.data.points).toEqual(["p"]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.attachments).toBe(1);
    const bad = new MockLlmProvider(() => ({ nope: true }));
    await expect(bad.generateJson(req)).rejects.toThrow();
  });
});
