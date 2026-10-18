import type { Readable } from "node:stream";
import type { ByteRange, StorageService, StoredObjectStream } from "./types.js";

/**
 * TODO(v2): S3-compatible backend (MinIO in docker-compose). Implement with
 * @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner; `signUrl` should return a presigned
 * GET so downloads bypass the API. Until then every method throws.
 */
export class S3StorageService implements StorageService {
  constructor(_opts: { bucket: string; endpoint?: string; region?: string }) {}

  private fail(): never {
    throw new Error("S3StorageService is not configured in this build");
  }
  put(_key: string, _data: Buffer | Readable, _mimeType: string): Promise<{ sizeBytes: number }> {
    return this.fail();
  }
  getStream(_key: string, _range?: ByteRange): Promise<StoredObjectStream> {
    return this.fail();
  }
  delete(_key: string): Promise<void> {
    return this.fail();
  }
  stat(_key: string): Promise<{ sizeBytes: number } | null> {
    return this.fail();
  }
  signUrl(_assetId: string, _ttlSec: number): { url: string; expiresAt: string } {
    return this.fail();
  }
}
