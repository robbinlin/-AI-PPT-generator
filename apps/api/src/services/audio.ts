import { spawn } from "node:child_process";
import type { AudioPause } from "@lvs/pipeline";

/** Parses ffmpeg `silencedetect` log lines into pauses. Exported for tests. */
export function parseSilenceLog(stderr: string): AudioPause[] {
  const out: AudioPause[] = [];
  let pending: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) pending = Number(s[1]);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && pending !== undefined) {
      out.push({ startSec: Math.max(0, pending), endSec: Number(e[1]) });
      pending = undefined;
    }
  }
  return out;
}

export interface DetectPausesOptions {
  ffmpegBin?: string;
  /** Silence threshold in dB relative to full scale. */
  noiseDb?: number;
  /** Minimum silence length counted as a pause, in seconds. */
  minSec?: number;
  signal?: AbortSignal;
}

/** Runs ffmpeg silencedetect on an audio file; returns [] when ffmpeg is unavailable. */
export function detectPauses(audioPath: string, opts: DetectPausesOptions = {}): Promise<AudioPause[]> {
  const bin = opts.ffmpegBin ?? "ffmpeg";
  const filter = `silencedetect=noise=${opts.noiseDb ?? -35}dB:d=${opts.minSec ?? 0.18}`;
  return new Promise((resolve) => {
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["-hide_banner", "-nostats", "-i", audioPath, "-af", filter, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"], signal: opts.signal });
    } catch {
      resolve([]);
      return;
    }
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(parseSilenceLog(stderr)));
  });
}
