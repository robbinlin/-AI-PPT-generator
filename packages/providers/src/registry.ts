import type { AvatarProvider, LlmProvider, ProviderCredentials, ProviderFactory, TtsProvider } from "@lvs/shared";
import { anthropicLlmFactory } from "./llm/anthropic.js";
import { geminiLlmFactory } from "./llm/gemini.js";
import { mockLlmFactory } from "./llm/mock.js";
import { elevenLabsTtsFactory } from "./tts/elevenlabs.js";
import { geminiTtsFactory } from "./tts/gemini.js";
import { yatingTtsFactory } from "./tts/yating.js";
import { localTtsFactory } from "./tts/local.js";
import { heyGenTtsFactory } from "./tts/heygen.js";
import { mockTtsFactory } from "./tts/mock.js";
import { heyGenAvatarFactory } from "./avatar/heygen.js";
import { localAvatarFactory } from "./avatar/local.js";
import { mockAvatarFactory } from "./avatar/mock.js";

export type ProviderKind = "llm" | "tts" | "avatar";

export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  displayName: string;
  requiresApiKey: boolean;
}

export class ProviderRegistry {
  private readonly llm = new Map<string, ProviderFactory<LlmProvider>>();
  private readonly tts = new Map<string, ProviderFactory<TtsProvider>>();
  private readonly avatar = new Map<string, ProviderFactory<AvatarProvider>>();

  registerLlm(f: ProviderFactory<LlmProvider>): this {
    this.llm.set(f.id, f);
    return this;
  }
  registerTts(f: ProviderFactory<TtsProvider>): this {
    this.tts.set(f.id, f);
    return this;
  }
  registerAvatar(f: ProviderFactory<AvatarProvider>): this {
    this.avatar.set(f.id, f);
    return this;
  }

  listProviders(kind?: ProviderKind): ProviderSummary[] {
    const out: ProviderSummary[] = [];
    const push = (k: ProviderKind, m: Map<string, ProviderFactory<unknown>>) => {
      for (const f of m.values()) out.push({ id: f.id, kind: k, displayName: f.displayName, requiresApiKey: f.requiresApiKey });
    };
    if (!kind || kind === "llm") push("llm", this.llm);
    if (!kind || kind === "tts") push("tts", this.tts);
    if (!kind || kind === "avatar") push("avatar", this.avatar);
    return out;
  }

  getFactory(kind: ProviderKind, id: string): ProviderFactory<unknown> | undefined {
    return (kind === "llm" ? this.llm : kind === "tts" ? this.tts : this.avatar).get(id);
  }

  createLlm(id: string, creds: ProviderCredentials = {}): LlmProvider {
    return create(this.llm, "llm", id, creds);
  }
  createTts(id: string, creds: ProviderCredentials = {}): TtsProvider {
    return create(this.tts, "tts", id, creds);
  }
  createAvatar(id: string, creds: ProviderCredentials = {}): AvatarProvider {
    return create(this.avatar, "avatar", id, creds);
  }
}

function create<P>(map: Map<string, ProviderFactory<P>>, kind: ProviderKind, id: string, creds: ProviderCredentials): P {
  const f = map.get(id);
  if (!f) throw new Error(`unknown ${kind} provider "${id}"`);
  if (f.requiresApiKey && !creds.apiKey) throw new Error(`${kind} provider "${id}" requires an API key`);
  return f.create(creds);
}

/** Everything shipped in this package. Mock providers respond with canned data. */
export const defaultRegistry = new ProviderRegistry()
  .registerLlm(geminiLlmFactory)
  .registerLlm(anthropicLlmFactory)
  .registerLlm(mockLlmFactory(() => ({})))
  .registerTts(geminiTtsFactory)
  .registerTts(elevenLabsTtsFactory)
  .registerTts(yatingTtsFactory)
  .registerTts(localTtsFactory)
  .registerTts(heyGenTtsFactory)
  .registerTts(mockTtsFactory)
  .registerAvatar(heyGenAvatarFactory)
  .registerAvatar(localAvatarFactory)
  .registerAvatar(mockAvatarFactory());
