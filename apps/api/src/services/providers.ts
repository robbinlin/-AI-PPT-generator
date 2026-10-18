import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ProviderInfo } from "@lvs/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { providerKeys } from "../db/schema.js";
import { notFound } from "../errors.js";

export interface ProviderDescriptor {
  id: string;
  kind: ProviderInfo["kind"];
  displayName: string;
  requiresApiKey: boolean;
  /** Config field holding the platform-managed key. */
  envKey?: keyof Config;
}

/**
 * Static catalogue. TODO(providers): replace with the registry exported by @lvs/providers
 * (`ProviderFactory[]`) so adding an adapter there is enough.
 */
export const PROVIDER_CATALOGUE: ProviderDescriptor[] = [
  { id: "gemini", kind: "llm", displayName: "Google Gemini", requiresApiKey: true, envKey: "GEMINI_API_KEY" },
  { id: "gemini-tts", kind: "tts", displayName: "Gemini TTS", requiresApiKey: true, envKey: "GEMINI_API_KEY" },
  { id: "anthropic", kind: "llm", displayName: "Anthropic Claude", requiresApiKey: true, envKey: "ANTHROPIC_API_KEY" },
  { id: "elevenlabs", kind: "tts", displayName: "ElevenLabs", requiresApiKey: true, envKey: "ELEVENLABS_API_KEY" },
  { id: "heygen", kind: "avatar", displayName: "HeyGen", requiresApiKey: true, envKey: "HEYGEN_API_KEY" },
  { id: "mock-llm", kind: "llm", displayName: "Mock LLM (tests)", requiresApiKey: false },
  { id: "mock-tts", kind: "tts", displayName: "Mock TTS (tests)", requiresApiKey: false },
  { id: "mock-avatar", kind: "avatar", displayName: "Mock avatar (tests)", requiresApiKey: false },
];

/** AES-256-GCM; output = base64(iv || ciphertext || tag). */
export class KeyCrypto {
  constructor(private readonly key: Buffer) {}
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
  }
  decrypt(blob: string): string {
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

export class ProviderService {
  private readonly crypto: KeyCrypto;
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.crypto = new KeyCrypto(config.providerKeyEncryptionKey);
  }

  descriptor(providerId: string): ProviderDescriptor {
    const d = PROVIDER_CATALOGUE.find((p) => p.id === providerId);
    if (!d) throw notFound("provider", providerId);
    return d;
  }

  private platformKey(d: ProviderDescriptor): string | undefined {
    return d.envKey ? (this.config[d.envKey] as string | undefined) || undefined : undefined;
  }

  async list(ownerId: string): Promise<ProviderInfo[]> {
    const stored = await this.db.select().from(providerKeys).where(eq(providerKeys.ownerId, ownerId));
    const storedIds = new Set(stored.map((r) => r.providerId));
    return PROVIDER_CATALOGUE.map((d) => ({
      id: d.id,
      kind: d.kind,
      displayName: d.displayName,
      requiresApiKey: d.requiresApiKey,
      configured: !d.requiresApiKey || !!this.platformKey(d) || storedIds.has(d.id),
    }));
  }

  async info(ownerId: string, providerId: string): Promise<ProviderInfo> {
    this.descriptor(providerId);
    const all = await this.list(ownerId);
    return all.find((p) => p.id === providerId)!;
  }

  async setKey(ownerId: string, providerId: string, apiKey: string): Promise<ProviderInfo> {
    this.descriptor(providerId);
    const ciphertext = this.crypto.encrypt(apiKey);
    await this.db
      .insert(providerKeys)
      .values({ ownerId, providerId, ciphertext })
      .onConflictDoUpdate({ target: [providerKeys.ownerId, providerKeys.providerId], set: { ciphertext, updatedAt: new Date() } });
    return this.info(ownerId, providerId);
  }

  async deleteKey(ownerId: string, providerId: string): Promise<ProviderInfo> {
    this.descriptor(providerId);
    await this.db.delete(providerKeys).where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.providerId, providerId)));
    return this.info(ownerId, providerId);
  }

  /** Resolved credentials: user key wins over platform key. Used by job handlers. */
  async credentials(ownerId: string, providerId: string): Promise<{ apiKey?: string }> {
    const d = this.descriptor(providerId);
    const [row] = await this.db
      .select()
      .from(providerKeys)
      .where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.providerId, providerId)))
      .limit(1);
    if (row) {
      try {
        return { apiKey: this.crypto.decrypt(row.ciphertext) };
      } catch {
        // Key encrypted under a previous process key (see config warning); fall through.
      }
    }
    return { apiKey: this.platformKey(d) };
  }
}
