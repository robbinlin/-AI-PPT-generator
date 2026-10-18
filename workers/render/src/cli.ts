#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { render } from "./index.js";

const USAGE = `usage: lvs-render <spec.json> [--work-dir dir] [--cache-dir dir] [--concurrency n]
                  [--ffmpeg path] [--ffprobe path]

Renders a RenderSpec (JSON) to MP4 (+ SRT when outputs.srtPath is set).
Progress goes to stderr as "PROGRESS <0..1> <message>"; the RenderResult JSON goes to stdout.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "work-dir": { type: "string" },
      "cache-dir": { type: "string" },
      concurrency: { type: "string" },
      ffmpeg: { type: "string" },
      ffprobe: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const specPath = positionals[0];
  if (!specPath || positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const spec: unknown = JSON.parse(await readFile(specPath, "utf8"));
  const workDir = values["work-dir"] ?? path.join(os.tmpdir(), `lvs-render-${process.pid}`);
  const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new Error(`--concurrency must be a positive integer`);
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let lastLine = "";
  const result = await render(spec as Parameters<typeof render>[0], {
    workDir,
    cacheDir: values["cache-dir"],
    ffmpegBin: values.ffmpeg,
    ffprobeBin: values.ffprobe,
    concurrency,
    signal: controller.signal,
    onProgress: (p, msg) => {
      const line = `PROGRESS ${p.toFixed(3)} ${msg}`;
      if (line !== lastLine) process.stderr.write(`${line}\n`);
      lastLine = line;
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof Error && err.name === "AbortError" ? 130 : 1;
  },
);
