import { spawn } from "node:child_process";

export const DEFAULT_FFMPEG = "ffmpeg";
export const DEFAULT_FFPROBE = "ffprobe";

const STDERR_TAIL_LINES = 40;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export class RenderAbortedError extends Error {
  constructor(message = "render aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderAbortedError();
}

export interface RunOptions {
  bin: string;
  args: string[];
  signal?: AbortSignal;
  cwd?: string;
  /** Expected output duration; enables fractional progress from `-progress pipe:1`. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
}

/** Keeps the last `max` lines of a stream without buffering all of it. */
class LineTail {
  private lines: string[] = [];
  private partial = "";
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }
  toString(): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-this.max).join("\n");
  }
}

/**
 * Runs ffmpeg with `-progress pipe:1` appended to the global options. Arguments are
 * passed straight to `spawn` (no shell), so paths are never interpolated.
 */
export function runFfmpeg(opts: RunOptions): Promise<void> {
  const args = ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", ...opts.args];
  return runProcess({ ...opts, args, parseProgress: true }).then(() => undefined);
}

/** Runs a process and resolves with its stdout. Rejects with an FfmpegError on failure. */
export function runProcess(
  opts: RunOptions & { parseProgress?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new RenderAbortedError());
      return;
    }
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const tail = new LineTail(STDERR_TAIL_LINES);
    let stdout = "";
    let progressBuf = "";
    let aborted = false;
    let settled = false;

    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!opts.parseProgress) {
        stdout += chunk;
        return;
      }
      progressBuf += chunk;
      const lines = progressBuf.split("\n");
      progressBuf = lines.pop() ?? "";
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if ((key === "out_time_us" || key === "out_time_ms") && opts.durationSec && opts.onProgress) {
          // Both keys are reported in microseconds by ffmpeg.
          const us = Number(value);
          if (Number.isFinite(us) && us >= 0) {
            opts.onProgress(Math.min(1, us / 1e6 / opts.durationSec));
          }
        } else if (key === "progress" && value === "end") {
          opts.onProgress?.(1);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => tail.push(chunk));

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(stdout);
    };

    child.on("error", (err) => {
      finish(
        aborted
          ? new RenderAbortedError()
          : new FfmpegError(`failed to start ${opts.bin}: ${err.message}`, null, tail.toString()),
      );
    });
    child.on("close", (code, sig) => {
      if (aborted) return finish(new RenderAbortedError());
      if (code === 0) return finish(null);
      const stderrTail = tail.toString();
      finish(
        new FfmpegError(
          `${opts.bin} exited with ${code ?? sig}\n--- last ${STDERR_TAIL_LINES} lines of stderr ---\n${stderrTail}`,
          code,
          stderrTail,
        ),
      );
    });
  });
}

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  format: { duration?: string; format_name?: string };
  streams: ProbeStream[];
}

export async function ffprobe(
  file: string,
  opts: { bin?: string; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const out = await runProcess({
    bin: opts.bin ?? DEFAULT_FFPROBE,
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    signal: opts.signal,
  });
  return JSON.parse(out) as ProbeResult;
}

export function probeDuration(p: ProbeResult): number {
  const d = Number(p.format.duration);
  if (Number.isFinite(d)) return d;
  const ds = p.streams.map((s) => Number(s.duration)).filter(Number.isFinite);
  return ds.length ? Math.max(...ds) : 0;
}

/** Formats a number for ffmpeg options without exponent notation. */
export function num(n: number, digits = 3): string {
  return Number(n.toFixed(digits)).toString();
}
