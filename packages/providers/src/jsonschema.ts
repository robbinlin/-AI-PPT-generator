import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type JsonSchema = Record<string, unknown>;

export interface SchemaOptions {
  /** Add `additionalProperties: false` to every object (Anthropic structured outputs). */
  closedObjects?: boolean;
  /** Remove keys some providers reject (`$schema`, `default`, `additionalProperties`). */
  strip?: string[];
}

/**
 * Convert a zod schema into plain JSON Schema suitable for provider "structured
 * output" parameters. The result is a deep-cloned object with no `$ref`s.
 */
export function zodToProviderSchema(schema: z.ZodTypeAny, opts: SchemaOptions = {}): JsonSchema {
  const raw = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
  const strip = new Set(["$schema", ...(opts.strip ?? [])]);
  return walk(raw, strip, opts.closedObjects ?? false) as JsonSchema;
}

function walk(node: unknown, strip: Set<string>, closed: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, strip, closed));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (strip.has(k)) continue;
    out[k] = k === "properties" ? walkProps(v, strip, closed) : walk(v, strip, closed);
  }
  if (closed && out.type === "object" && out.properties && !("additionalProperties" in out)) {
    out.additionalProperties = false;
  }
  return out;
}

function walkProps(props: unknown, strip: Set<string>, closed: boolean): unknown {
  if (!props || typeof props !== "object") return props;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) out[k] = walk(v, strip, closed);
  return out;
}

/** Strip ```json fences and leading prose so `JSON.parse` succeeds on chatty responses. */
export function extractJsonText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = Math.min(...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0));
  if (Number.isFinite(start)) {
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end > start) return text.slice(start, end + 1);
  }
  return text.trim();
}
