import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { parseModelList, withGeminiRetry } from "../gemini-retry.js";
import type { LlmJsonRequest, LlmProvider, ProviderCredentials, ProviderFactory, ProviderResult } from "@lvs/shared";
import { extractJsonText, zodToProviderSchema } from "../jsonschema.js";
import { toBase64 } from "../http.js";

/** Overridable with GEMINI_LLM_MODEL; gemini-2.5-pro is no longer offered to new API keys. */
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
const envLlmModel = () => process.env.GEMINI_LLM_MODEL || GEMINI_DEFAULT_MODEL;

/** Shape of the `generateContent` call we make; exported so tests can assert on it without the SDK. */
export interface GeminiJsonCall {
  model: string;
  contents: { role: "user"; parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> }[];
  config: {
    systemInstruction: string;
    responseMimeType: "application/json";
    responseJsonSchema: Record<string, unknown>;
    temperature?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: ThinkingLevel };
  };
}

/**
 * Gemini 3.x models think before answering by default (≈1k hidden tokens, 2–3× the latency on a
 * script-sized prompt). Scripts don't need it; the outline benefits from a little.
 */
export function thinkingConfigFor(reasoning: LlmJsonRequest<unknown>["reasoning"], model = ""): GeminiJsonCall["config"]["thinkingConfig"] | undefined {
  const forced = process.env.GEMINI_THINKING;
  const level = forced === "none" || forced === "low" || forced === "high" ? forced : (reasoning ?? "high");
  // The lite models reject thinkingBudget: 0 but accept the LOW level, which is already fast.
  if (level === "none") return /lite/.test(model) ? { thinkingLevel: ThinkingLevel.LOW } : { thinkingBudget: 0 };
  if (level === "low") return { thinkingLevel: ThinkingLevel.LOW };
  return undefined;
}

/**
 * Fast model for tasks that need no deliberation (per-slide scripts). On free-tier keys the
 * flagship flash model is heavily throttled (40–140 s per call) while the lite models answer in
 * ~2 s with comparable zh-TW prose, so "reasoning: none" requests are routed here by default.
 */
export const GEMINI_FAST_MODEL = "gemini-3.5-flash-lite";
const envFastModel = () => process.env.GEMINI_FAST_MODEL || GEMINI_FAST_MODEL;

export function buildGeminiJsonCall<T>(req: LlmJsonRequest<T>, defaultModel = GEMINI_DEFAULT_MODEL): GeminiJsonCall {
  const parts: GeminiJsonCall["contents"][number]["parts"] = [];
  for (const a of req.attachments ?? []) {
    if (a.label) parts.push({ text: `[${a.label}]` });
    parts.push({ inlineData: { mimeType: a.mimeType, data: toBase64(a.data) } });
  }
  parts.push({ text: req.prompt });
  return {
    model: req.model ?? defaultModel,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: req.system,
      responseMimeType: "application/json",
      // Gemini's JSON-schema mode rejects a few JSON Schema keywords; strip them.
      responseJsonSchema: zodToProviderSchema(req.schema, { strip: ["default", "additionalProperties"] }),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(thinkingConfigFor(req.reasoning, req.model ?? defaultModel) ? { thinkingConfig: thinkingConfigFor(req.reasoning, req.model ?? defaultModel) } : {}),
    },
  };
}

export interface GeminiLikeResponse {
  text?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  responseId?: string;
}

export function mapGeminiJsonResponse<T>(res: GeminiLikeResponse, req: LlmJsonRequest<T>): ProviderResult<T> {
  const text = res.text ?? "";
  if (!text.trim()) throw new Error("gemini returned an empty response");
  const data = req.schema.parse(JSON.parse(extractJsonText(text)));
  return {
    data,
    usage: [
      { unit: "tokens_in", quantity: res.usageMetadata?.promptTokenCount ?? 0 },
      { unit: "tokens_out", quantity: res.usageMetadata?.candidatesTokenCount ?? 0 },
    ],
    ...(res.responseId ? { providerRequestId: res.responseId } : {}),
  };
}

export class GeminiLlmProvider implements LlmProvider {
  readonly id = "gemini";
  readonly defaultModel: string;
  private readonly ai: GoogleGenAI;

  constructor(creds: ProviderCredentials, defaultModel = GEMINI_DEFAULT_MODEL) {
    if (!creds.apiKey) throw new Error("gemini: apiKey required");
    this.ai = new GoogleGenAI({ apiKey: creds.apiKey, ...(creds.baseUrl ? { httpOptions: { baseUrl: creds.baseUrl } } : {}) });
    this.defaultModel = defaultModel;
  }

  async generateJson<T>(req: LlmJsonRequest<T>): Promise<ProviderResult<T>> {
    const fast = req.reasoning === "none" && !req.model;
    const primary = req.model ?? (fast ? envFastModel() : this.defaultModel);
    const fallbacks = fast
      ? parseModelList(process.env.GEMINI_FAST_FALLBACK_MODELS, `gemini-3.1-flash-lite,${this.defaultModel}`)
      : parseModelList(process.env.GEMINI_LLM_FALLBACK_MODELS, "gemini-3.5-flash");
    const models = [primary, ...fallbacks.filter((m) => m !== primary)];
    return withGeminiRetry(models, async (model) => {
      const call = buildGeminiJsonCall({ ...req, model }, this.defaultModel);
      const res = await this.ai.models.generateContent(call);
      return mapGeminiJsonResponse(res as GeminiLikeResponse, req);
    });
  }
}

export const geminiLlmFactory: ProviderFactory<LlmProvider> = {
  id: "gemini",
  displayName: "Google Gemini",
  requiresApiKey: true,
  create: (creds) => new GeminiLlmProvider(creds, envLlmModel()),
};
