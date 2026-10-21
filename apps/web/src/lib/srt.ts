import type { SubtitleCue } from "@lvs/shared";

const TIME = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})/;

function parseTime(s: string): number | null {
  const m = TIME.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
}

/** Parses SubRip text into cues (lenient: skips malformed blocks). */
export function parseSrt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of text.replace(/\r/g, "").trim().split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing === -1) continue;
    const [a, b] = lines[timing]!.split("-->");
    const startSec = parseTime(a ?? "");
    const endSec = parseTime(b ?? "");
    if (startSec === null || endSec === null) continue;
    const body = lines.slice(timing + 1).join("\n").trim();
    if (!body) continue;
    cues.push({ index: cues.length + 1, startSec, endSec, text: body });
  }
  return cues;
}

/** Cue showing at `timeSec`; falls back to the first cue before playback starts. */
export function cueAt(cues: SubtitleCue[], timeSec: number): SubtitleCue | undefined {
  if (cues.length === 0) return undefined;
  if (timeSec <= 0) return cues[0];
  return cues.find((c) => timeSec >= c.startSec && timeSec < c.endSec);
}
