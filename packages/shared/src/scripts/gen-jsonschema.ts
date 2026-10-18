/**
 * Emits JSON Schema files consumed by the Python parser worker and by tests,
 * so non-TypeScript code validates against the same contract.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ParserManifest, SlideContent } from "../parser.js";
import { RenderSpec, RenderResult } from "../media.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "schemas");
mkdirSync(outDir, { recursive: true });

const targets = {
  "parser-manifest": ParserManifest,
  "slide-content": SlideContent,
  "render-spec": RenderSpec,
  "render-result": RenderResult,
} as const;

for (const [name, schema] of Object.entries(targets)) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: "none" });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(targets).length} schemas to ${outDir}`);
