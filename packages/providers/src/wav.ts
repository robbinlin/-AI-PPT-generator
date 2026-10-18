/** PCM <-> WAV helpers. All PCM is signed 16-bit little-endian. */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample?: number;
}

/** Wrap raw PCM bytes in a RIFF/WAVE container. */
export function pcmToWav(pcm: Uint8Array, fmt: PcmFormat): Uint8Array {
  const bits = fmt.bitsPerSample ?? 16;
  const blockAlign = (fmt.channels * bits) / 8;
  const byteRate = fmt.sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, fmt.channels, true);
  v.setUint32(24, fmt.sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export function pcmDurationSec(byteLength: number, fmt: PcmFormat): number {
  const bits = fmt.bitsPerSample ?? 16;
  return byteLength / (fmt.sampleRate * fmt.channels * (bits / 8));
}

/** Produce a WAV file of digital silence. */
export function silentWav(durationSec: number, fmt: PcmFormat = { sampleRate: 24_000, channels: 1 }): Uint8Array {
  const bits = fmt.bitsPerSample ?? 16;
  const bytes = Math.round(durationSec * fmt.sampleRate * fmt.channels * (bits / 8));
  // keep sample alignment
  const aligned = bytes - (bytes % ((fmt.channels * bits) / 8));
  return pcmToWav(new Uint8Array(aligned), fmt);
}

/** Read sample rate / channels / data length back out of a WAV header (for tests and probes). */
export function parseWavHeader(wav: Uint8Array): PcmFormat & { dataBytes: number; durationSec: number } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bitsPerSample = v.getUint16(34, true);
  // walk chunks to find "data"
  let off = 12;
  while (off + 8 <= wav.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "data") {
      const fmt = { sampleRate, channels, bitsPerSample };
      return { ...fmt, dataBytes: size, durationSec: pcmDurationSec(size, fmt) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
}

/** Parse the sample rate out of a MIME type such as `audio/L16;codec=pcm;rate=24000`. */
export function sampleRateFromMime(mime: string | undefined, fallback = 24_000): number {
  const m = /rate=(\d+)/.exec(mime ?? "");
  return m ? Number(m[1]) : fallback;
}
