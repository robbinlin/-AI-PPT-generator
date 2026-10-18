import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const exec = promisify(execFile);
export const FFMPEG = process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg";
export const FFPROBE = process.env.FFPROBE_BIN ?? "/usr/bin/ffprobe";

export async function tmpDir(prefix = "lvs-render-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 16-bit PCM mono WAV with a sine tone. */
export async function writeSineWav(file: string, durationSec: number, freq = 440, sampleRate = 48_000): Promise<void> {
  const samples = Math.round(durationSec * sampleRate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5 * 32767), 44 + i * 2);
  }
  await writeFile(file, buf);
}

// --- minimal PNG encoder (RGB, 8-bit, filter 0) -----------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export async function writeSolidPng(file: string, width: number, height: number, rgb: [number, number, number]): Promise<void> {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await writeFile(file, png);
}

// --- ffmpeg helpers ----------------------------------------------------------

export async function makeTestsrcVideo(file: string, durationSec = 1): Promise<void> {
  await exec(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=15:duration=${durationSec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
}

export interface Probe {
  duration: number;
  video?: { width: number; height: number; codec: string; pixFmt: string };
  audio?: { duration: number; codec: string; sampleRate: number; channels: number };
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout) as {
    format: { duration: string };
    streams: Array<Record<string, string | number>>;
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(j.format.duration),
    video: v && { width: Number(v.width), height: Number(v.height), codec: String(v.codec_name), pixFmt: String(v.pix_fmt) },
    audio: a && {
      duration: Number(a.duration),
      codec: String(a.codec_name),
      sampleRate: Number(a.sample_rate),
      channels: Number(a.channels),
    },
  };
}

/** Extracts the frame at `atSec` to PNG, then decodes that PNG to raw RGB for pixel reads. */
export async function grabFrame(
  mp4: string,
  atSec: number,
  pngOut: string,
): Promise<{ width: number; height: number; pixel: (x: number, y: number) => [number, number, number] }> {
  await exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", pngOut]);
  const rawPath = `${pngOut}.rgb`;
  await exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", pngOut, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath]);
  const p = await probe(pngOut);
  const width = p.video?.width ?? 0;
  const height = p.video?.height ?? 0;
  const raw = await readFile(rawPath);
  return {
    width,
    height,
    pixel: (x, y) => {
      const o = (Math.round(y) * width + Math.round(x)) * 3;
      return [raw[o] ?? 0, raw[o + 1] ?? 0, raw[o + 2] ?? 0];
    },
  };
}

export function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}
