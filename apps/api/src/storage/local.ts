import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetUrlSigner } from "./signing.js";
import type { ByteRange, StorageService, StoredObjectStream } from "./types.js";

/** Filesystem-backed storage. Keys are slash-separated relative paths; traversal is rejected. */
export class LocalStorageService implements StorageService {
  private readonly root: string;

  constructor(
    root: string,
    private readonly signer: AssetUrlSigner,
  ) {
    this.root = resolve(root);
  }

  localPath(key: string): string {
    const full = resolve(this.root, normalize(key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`storage key escapes root: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer | Readable, _mimeType: string): Promise<{ sizeBytes: number }> {
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await writeFile(path, data);
      return { sizeBytes: data.length };
    }
    await pipeline(data, createWriteStream(path));
    const s = await stat(path);
    return { sizeBytes: s.size };
  }

  async getStream(key: string, range?: ByteRange): Promise<StoredObjectStream> {
    const path = this.localPath(key);
    const s = await stat(path);
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? s.size - 1, s.size - 1);
    if (start > end || start >= s.size) {
      throw new RangeError(`invalid range ${start}-${end} for size ${s.size}`);
    }
    return { stream: createReadStream(path, { start, end }), size: s.size, start, end };
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const s = await stat(this.localPath(key));
      return { sizeBytes: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  signUrl(assetId: string, ttlSec: number): { url: string; expiresAt: string } {
    const { url, expiresAt } = this.signer.sign(assetId, ttlSec);
    return { url, expiresAt };
  }

  /** Helper for building keys consistently. */
  static key(...parts: string[]): string {
    return join(...parts).split(sep).join("/");
  }
}
