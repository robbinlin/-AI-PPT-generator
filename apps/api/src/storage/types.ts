import type { Readable } from "node:stream";

export interface ByteRange {
  start: number;
  /** Inclusive. Defaults to the last byte. */
  end?: number;
}

export interface StoredObjectStream {
  stream: Readable;
  /** Total object size, not the range size. */
  size: number;
  start: number;
  end: number;
}

export interface StorageService {
  put(key: string, data: Buffer | Readable, mimeType: string): Promise<{ sizeBytes: number }>;
  getStream(key: string, range?: ByteRange): Promise<StoredObjectStream>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** Absolute filesystem path when the backend is local; used by workers that need files. */
  localPath?(key: string): string;
  /** Signed public URL for an asset id (not the storage key), valid for `ttlSec`. */
  signUrl(assetId: string, ttlSec: number): { url: string; expiresAt: string };
}
