import { createHash } from "node:crypto";

/** Stable JSON serialisation: sorted keys, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON of `inputs`. Use for every asset `inputHash`. */
export function contentHash(inputs: unknown): string {
  return createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
