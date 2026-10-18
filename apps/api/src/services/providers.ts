import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AvatarProvider, LlmProvider, ProviderInfo, TtsProvider } from "@lvs/shared";
import { defaultRegistry, type ProviderKind, type ProviderRegistry } from "@lvs/providers";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { providerKeys } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";

export interface ProviderDescriptor {
  id: string;
  kind: ProviderInfo["kind"];
  displayName: string;
  requiresApiKey: boolean;
  /** Config field holding the platform-managed key. */
  envKey?: keyof Config;
}

/** Which env var feeds each provider id; providers that share a vendor share a key (gemini llm + tts). */
const ENV_KEYS: Record<string, keyof Config> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  heygen: "HEYGEN_API_KEY",
};

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

export class ProviderNotConfiguredError extends Error {
  constructor(kind: ProviderKind, id: string) {
    super(`${kind} provider "${id}" has no API key configured (set the platform key or add one under settings → providers)`);
    this.name = "ProviderNotConfiguredError";
  }
}

/**
 * Catalogue + credentials. The catalogue is derived from `@lvs/providers`' registry so adding
 * an adapter there is enough; keys are stored per owner, AES-256-GCM encrypted.
 */
export class ProviderService {
  private readonly crypto: KeyCrypto;
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    readonly registry: ProviderRegistry = defaultRegistry,
  ) {
    this.crypto = new KeyCrypto(config.providerKeyEncryptionKey);
  }

  catalogue(): ProviderDescriptor[] {
    return this.registry.listProviders().map((p) => ({ ...p, envKey: ENV_KEYS[p.id] }));
  }

  /** First descriptor with this id; pass `kind` when the id is shared across kinds (gemini). */
  descriptor(providerId: string, kind?: ProviderKind): ProviderDescriptor {
    const d = this.catalogue().find((p) => p.id === providerId && (!kind || p.kind === kind));
    if (!d) throw notFound("provider", kind ? `${providerId} (${kind})` : providerId);
    return d;
  }

  private platformKey(d: ProviderDescriptor): string | undefined {
    return d.envKey ? (this.config[d.envKey] as string | undefined) || undefined : undefined;
  }

  async list(ownerId: string): Promise<ProviderInfo[]> {
    const stored = await this.db.select().from(providerKeys).where(eq(providerKeys.ownerId, ownerId));
    const storedIds = new Set(stored.map((r) => r.providerId));
    return this.catalogue().map((d) => ({
      id: d.id,
      kind: d.kind,
      displayName: d.displayName,
      requiresApiKey: d.requiresApiKey,
      configured: !d.requiresApiKey || !!this.platformKey(d) || storedIds.has(d.id),
    }));
  }

  async info(ownerId: string, providerId: string, kind?: ProviderKind): Promise<ProviderInfo> {
    const d = this.descriptor(providerId, kind);
    const all = await this.list(ownerId);
    return all.find((p) => p.id === providerId && p.kind === d.kind)!;
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

  private async resolve<P>(ownerId: string, kind: ProviderKind, id: string, make: (creds: { apiKey?: string }) => P): Promise<P> {
    const d = this.descriptor(id, kind);
    const creds = await this.credentials(ownerId, id);
    if (d.requiresApiKey && !creds.apiKey) throw new ProviderNotConfiguredError(kind, id);
    return make(creds);
  }

  llm(ownerId: string, id: string): Promise<LlmProvider> {
    return this.resolve(ownerId, "llm", id, (c) => this.registry.createLlm(id, c));
  }
  tts(ownerId: string, id: string): Promise<TtsProvider> {
    return this.resolve(ownerId, "tts", id, (c) => this.registry.createTts(id, c));
  }
  avatar(ownerId: string, id: string): Promise<AvatarProvider> {
    return this.resolve(ownerId, "avatar", id, (c) => this.registry.createAvatar(id, c));
  }

  /** Route helper: 400 instead of a job error when a key is missing. */
  async requireTts(ownerId: string, id: string): Promise<TtsProvider> {
    try {
      return await this.tts(ownerId, id);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw badRequest(e.message);
      throw e;
    }
  }
  async requireAvatar(ownerId: string, id: string): Promise<AvatarProvider> {
    try {
      return await this.avatar(ownerId, id);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw badRequest(e.message);
      throw e;
    }
  }
}
