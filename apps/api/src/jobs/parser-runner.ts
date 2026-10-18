import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ParserManifest, type SourceKind } from "@lvs/shared";
import { NonRetryableJobError } from "../errors.js";

export interface ParserRunInput {
  filePath: string;
  outDir: string;
  kind: SourceKind;
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

/** Abstraction over the Python parser so tests can substitute a fake. */
export interface ParserRunner {
  run(input: ParserRunInput): Promise<ParserManifest>;
}

export interface PythonParserOptions {
  python: string;
  /** Working directory containing the `lvs_parser` package (workers/parser). */
  cwd: string;
  timeoutMs: number;
  sofficeBin?: string;
}

/**
 * Spawns `python3 -m lvs_parser parse <file> --out <dir>`.
 * Progress protocol (stderr, one per line): `PROGRESS <0..1> <message>`.
 * The worker writes `<outDir>/manifest.json` conforming to `ParserManifest`.
 */
export class PythonParserRunner implements ParserRunner {
  constructor(private readonly opts: PythonParserOptions) {}

  async run(input: ParserRunInput): Promise<ParserManifest> {
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(this.opts.python, ["-I", "-m", "lvs_parser", "parse", input.filePath, "--out", input.outDir], {
        cwd: this.opts.cwd,
        env: { ...process.env, SOFFICE_BIN: this.opts.sofficeBin ?? "soffice", PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      let buffered = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.opts.timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      input.signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^PROGRESS\s+([0-9.]+)\s*(.*)$/.exec(line.trim());
          if (m) input.onProgress?.(Math.min(1, Math.max(0, Number(m[1]))), m[2] || undefined);
          else stderrTail = (stderrTail + line + "\n").slice(-4000);
        }
      });
      child.stdout.on("data", () => {});
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        if (input.signal?.aborted) return reject(Object.assign(new Error("parser aborted"), { name: "AbortError" }));
        if (code === 0) return resolveRun();
        const msg = `parser exited with ${code ?? sig}: ${stderrTail.trim()}`;
        // Exit code 2 is reserved by the worker for "unsupported / corrupt input".
        reject(code === 2 ? new NonRetryableJobError(msg) : new Error(msg));
      });
    });
    const raw = await readFile(join(input.outDir, "manifest.json"), "utf8");
    return ParserManifest.parse(JSON.parse(raw));
  }
}
