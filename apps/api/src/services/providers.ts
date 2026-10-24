import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  AvatarProvider,
  LlmProvider,
  ProviderInfo,
  TtsProvider,
} from "@lvs/shared";
import {
  defaultRegistry,
  type ProviderKind,
  type ProviderRegistry,
} from "@lvs/providers";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { providerKeys } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { checkProviderKey } from "./keyCheck.js";

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
  yating: "YATING_API_KEY",
  heygen: "HEYGEN_API_KEY",
};

/** Self-hosted providers get their service address from config instead of a key. */
const BASE_URLS: Record<string, keyof Config> = {
  "avatar:local": "LOCAL_AVATAR_URL",
  "tts:local": "LOCAL_TTS_URL",
};

/** TTS providers that take a reference clip of the user's own voice. */
const CUSTOM_VOICE_PROVIDERS = new Set(["local", "mock"]);

/** Avatar providers that take the user's own photo/video as a character. */
const CUSTOM_CHARACTER_PROVIDERS = new Set(["local", "mock"]);

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
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  }
}

const PROVIDER_KIND_LABEL: Record<string, string> = { llm: "AI 講稿", tts: "語音", avatar: "人像" };

/** Display name for a provider id in user-facing messages ("HeyGen 產生失敗：…"). */
export function providerLabel(id: string): string {
  const known: Record<string, string> = { gemini: "Gemini", anthropic: "Claude", elevenlabs: "ElevenLabs", yating: "雅婷", heygen: "HeyGen", local: "本機", mock: "Mock", render: "影片合成" };
  return known[id] ?? id;
}

export class ProviderNotConfiguredError extends Error {
  constructor(
    public readonly kind: ProviderKind,
    public readonly providerId: string,
  ) {
    super(
      `${PROVIDER_KIND_LABEL[kind] ?? kind}服務「${providerLabel(providerId)}」還沒有設定 API 金鑰，請到右上角「進階設定」貼上金鑰`,
    );
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
    return (
      this.registry
        .listProviders()
        // Mock providers only output placeholders; users must never see them as real options.
        .filter((p) => p.id !== "mock" || this.config.EXPOSE_MOCK_PROVIDERS)
        .map((p) => ({ ...p, envKey: ENV_KEYS[p.id] }))
    );
  }

  /** First descriptor with this id; pass `kind` when the id is shared across kinds (gemini). */
  descriptor(providerId: string, kind?: ProviderKind): ProviderDescriptor {
    const d = this.catalogue().find(
      (p) => p.id === providerId && (!kind || p.kind === kind),
    );
    if (!d)
      throw notFound("provider", kind ? `${providerId} (${kind})` : providerId);
    return d;
  }

  private readable(ciphertext: string): boolean {
    try {
      this.crypto.decrypt(ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  private platformKey(d: ProviderDescriptor): string | undefined {
    return d.envKey
      ? (this.config[d.envKey] as string | undefined) || undefined
      : undefined;
  }

  async list(ownerId: string): Promise<ProviderInfo[]> {
    const stored = await this.db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.ownerId, ownerId));
    // A key encrypted under an older process key is useless: show the provider as unconfigured
    // so the user knows to paste the key again instead of getting "no API key" at run time.
    const storedIds = new Set(
      stored
        .filter((r) => this.readable(r.ciphertext))
        .map((r) => r.providerId),
    );
    return Promise.all(
      this.catalogue().map(async (d) => {
        // A user key wins over the platform key (see credentials()), so report it first.
        const keySource = !d.requiresApiKey
          ? undefined
          : storedIds.has(d.id)
            ? "user"
            : this.platformKey(d)
              ? "platform"
              : undefined;
        const probe = d.requiresApiKey ? undefined : await this.probe(d);
        return {
          id: d.id,
          kind: d.kind,
          displayName: d.displayName,
          requiresApiKey: d.requiresApiKey,
          configured: d.requiresApiKey
            ? keySource !== undefined
            : (probe?.ok ?? true),
          ...(keySource ? { keySource } : {}),
          ...(probe?.hint ? { hint: probe.hint } : {}),
          ...(d.kind === "avatar" && CUSTOM_CHARACTER_PROVIDERS.has(d.id)
            ? { customCharacters: true }
            : {}),
          ...(d.kind === "tts" && CUSTOM_VOICE_PROVIDERS.has(d.id)
            ? { customVoices: true }
            : {}),
        } satisfies ProviderInfo;
      }),
    );
  }

  private readonly probeCache = new Map<
    string,
    { at: number; result: { ok: boolean; hint?: string } }
  >();

  /** Self-hosted services report whether they are reachable; cached briefly since the list is fetched often. */
  private async probe(
    d: ProviderDescriptor,
  ): Promise<{ ok: boolean; hint?: string } | undefined> {
    const cached = this.probeCache.get(`${d.kind}:${d.id}`);
    if (cached && Date.now() - cached.at < 5_000) return cached.result;
    let result: { ok: boolean; hint?: string } | undefined;
    try {
      const instance = this.instantiate(
        d.kind,
        d.id,
        await this.credentials("", d.id, d.kind),
      );
      if (
        instance &&
        typeof (instance as { probe?: unknown }).probe === "function"
      ) {
        result = await (
          instance as { probe: () => Promise<{ ok: boolean; hint?: string }> }
        ).probe();
      }
    } catch {
      result = undefined;
    }
    if (result)
      this.probeCache.set(`${d.kind}:${d.id}`, { at: Date.now(), result });
    return result;
  }

  private instantiate(
    kind: ProviderKind,
    id: string,
    creds: { apiKey?: string; baseUrl?: string },
  ): unknown {
    if (kind === "llm") return this.registry.createLlm(id, creds);
    if (kind === "tts") return this.registry.createTts(id, creds);
    return this.registry.createAvatar(id, creds);
  }

  async info(
    ownerId: string,
    providerId: string,
    kind?: ProviderKind,
  ): Promise<ProviderInfo> {
    const d = this.descriptor(providerId, kind);
    const all = await this.list(ownerId);
    return all.find((p) => p.id === providerId && p.kind === d.kind)!;
  }

  async setKey(
    ownerId: string,
    providerId: string,
    apiKey: string,
  ): Promise<ProviderInfo> {
    this.descriptor(providerId);
    if (this.config.VERIFY_PROVIDER_KEYS && (await checkProviderKey(providerId, apiKey)) === "invalid")
      throw badRequest(`金鑰無效或沒有權限：${providerLabel(providerId)} 拒絕了這把金鑰。請確認整串都有複製到，或到 ${providerLabel(providerId)} 後台確認權限。`);
    const ciphertext = this.crypto.encrypt(apiKey);
    await this.db
      .insert(providerKeys)
      .values({ ownerId, providerId, ciphertext })
      .onConflictDoUpdate({
        target: [providerKeys.ownerId, providerKeys.providerId],
        set: { ciphertext, updatedAt: new Date() },
      });
    return this.info(ownerId, providerId);
  }

  async deleteKey(ownerId: string, providerId: string): Promise<ProviderInfo> {
    this.descriptor(providerId);
    await this.db
      .delete(providerKeys)
      .where(
        and(
          eq(providerKeys.ownerId, ownerId),
          eq(providerKeys.providerId, providerId),
        ),
      );
    return this.info(ownerId, providerId);
  }

  /** Resolved credentials: user key wins over platform key. Used by job handlers. */
  async credentials(
    ownerId: string,
    providerId: string,
    kind?: ProviderKind,
  ): Promise<{ apiKey?: string; baseUrl?: string }> {
    const d = this.descriptor(providerId, kind);
    const urlKey = BASE_URLS[`${d.kind}:${providerId}`];
    const baseUrl = urlKey
      ? (this.config[urlKey] as string | undefined)
      : undefined;
    const withBase = (c: { apiKey?: string }) =>
      baseUrl ? { ...c, baseUrl } : c;
    const [row] = await this.db
      .select()
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.ownerId, ownerId),
          eq(providerKeys.providerId, providerId),
        ),
      )
      .limit(1);
    if (row) {
      try {
        return withBase({ apiKey: this.crypto.decrypt(row.ciphertext) });
      } catch {
        // Key encrypted under a previous process key (see config warning); fall through.
      }
    }
    return withBase({ apiKey: this.platformKey(d) });
  }

  private async resolve<P>(
    ownerId: string,
    kind: ProviderKind,
    id: string,
    make: (creds: { apiKey?: string; baseUrl?: string }) => P,
  ): Promise<P> {
    const d = this.descriptor(id, kind);
    const creds = await this.credentials(ownerId, id, kind);
    if (d.requiresApiKey && !creds.apiKey)
      throw new ProviderNotConfiguredError(kind, id);
    return make(creds);
  }

  llm(ownerId: string, id: string): Promise<LlmProvider> {
    return this.resolve(ownerId, "llm", id, (c) =>
      this.registry.createLlm(id, c),
    );
  }
  tts(ownerId: string, id: string): Promise<TtsProvider> {
    return this.resolve(ownerId, "tts", id, (c) =>
      this.registry.createTts(id, c),
    );
  }
  avatar(ownerId: string, id: string): Promise<AvatarProvider> {
    return this.resolve(ownerId, "avatar", id, (c) =>
      this.registry.createAvatar(id, c),
    );
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
