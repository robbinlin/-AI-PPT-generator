import type { z } from "zod";
import type { AspectRatio, Language } from "./enums.js";
import type { GlossaryEntry, WordTimestamp } from "./entities.js";

/**
 * Provider interfaces. Implementations live in packages/providers.
 * Every provider is replaceable; the API only talks to these shapes.
 */

export interface UsageDelta {
  unit: "chars" | "tokens_in" | "tokens_out" | "audio_seconds" | "avatar_seconds";
  quantity: number;
}

export interface ProviderResult<T> {
  data: T;
  usage: UsageDelta[];
  /** Raw provider request/response ids for debugging. */
  providerRequestId?: string;
}

// ---------------------------------------------------------------- LLM ------

export interface LlmAttachment {
  mimeType: string;
  data: Uint8Array;
  /** Short label used in the prompt, e.g. "slide 5 image". */
  label?: string;
}

export interface LlmJsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  attachments?: LlmAttachment[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * How much the model should deliberate before answering. "none" disables extended thinking
   * (fast; right for per-slide scripts), "low" keeps a little (outline planning), "high" leaves
   * the provider default. Providers without the knob ignore it.
   */
  reasoning?: "none" | "low" | "high";
}

export interface LlmProvider {
  readonly id: string;
  readonly defaultModel: string;
  generateJson<T>(req: LlmJsonRequest<T>): Promise<ProviderResult<T>>;
}

// ---------------------------------------------------------------- TTS ------

export interface Voice {
  id: string;
  name: string;
  languages: Language[];
  gender?: "female" | "male" | "neutral";
  previewUrl?: string;
  /** Provider-specific tags such as "news", "calm". */
  tags?: string[];
}

export interface TtsCapabilities {
  wordTimestamps: boolean;
  ssml: boolean;
  speedControl: boolean;
  maxChars: number;
  /** Output container the provider returns, e.g. "audio/mpeg", "audio/wav", "audio/L16;rate=24000". */
  outputMimeType: string;
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  language: Language;
  speed?: number;
  sentencePauseSec?: number;
  /** Glossary with readings; providers that support lexicons apply it, others ignore it. */
  pronunciation?: GlossaryEntry[];
}

export interface TtsResult {
  audio: Uint8Array;
  mimeType: string;
  sampleRate?: number;
  durationSec: number;
  timestamps?: WordTimestamp[];
}

export interface TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  listVoices(): Promise<Voice[]>;
  synthesize(req: TtsRequest): Promise<ProviderResult<TtsResult>>;
}

// ------------------------------------------------------------- Avatar ------

export interface AvatarCharacter {
  id: string;
  name: string;
  previewImageUrl?: string;
  /** "stock" = platform library, "personal" = user-licensed likeness. */
  kind: "stock" | "personal";
}

export interface AvatarCapabilities {
  acceptsAudio: boolean;
  acceptsText: boolean;
  transparentBackground: boolean;
  maxDurationSec: number;
  aspectRatios: AspectRatio[];
  /** Billing unit the provider charges by, for estimates. */
  billingUnit: "avatar_seconds";
  /** The user can upload their own photo/video as a character (see `createCharacter`). */
  customCharacters?: boolean;
}

export interface AvatarCreateRequest {
  avatarId: string;
  aspectRatio: AspectRatio;
  /** Audio bytes; providers that accept uploads use these and never need a public URL. */
  audio?: { data: Uint8Array; mimeType: string; fileName?: string };
  /** Public URL fallback for providers that only fetch audio. One of audio / audioUrl / text is required. */
  audioUrl?: string;
  text?: string;
  voiceId?: string;
  transparent?: boolean;
  /** Echoed back by webhooks; use the job id. */
  clientReference?: string;
}

export interface AvatarTaskStatus {
  taskId: string;
  status: "queued" | "processing" | "succeeded" | "failed" | "cancelled";
  progress?: number;
  resultUrl?: string;
  durationSec?: number;
  error?: string;
}

export interface AvatarProvider {
  readonly id: string;
  readonly capabilities: AvatarCapabilities;
  listAvatars(): Promise<AvatarCharacter[]>;
  createTask(req: AvatarCreateRequest): Promise<{ taskId: string }>;
  getTask(taskId: string): Promise<AvatarTaskStatus>;
  cancelTask(taskId: string): Promise<void>;
  /** Self-hosted providers: is the service reachable, and if not (or degraded), what should the user do? */
  probe?(): Promise<{ ok: boolean; hint?: string }>;
  /** Providers with `capabilities.customCharacters`. */
  createCharacter?(input: { data: Uint8Array; mimeType: string; fileName: string; name: string }): Promise<AvatarCharacter>;
  deleteCharacter?(id: string): Promise<void>;
  characterPreview?(id: string): Promise<{ data: Uint8Array; mimeType: string }>;
}

// ------------------------------------------------------------ Registry -----

export interface ProviderCredentials {
  /** Platform-managed key from env, or the user's own key decrypted from DB. */
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderFactory<P> {
  id: string;
  displayName: string;
  requiresApiKey: boolean;
  create(creds: ProviderCredentials): P;
}
