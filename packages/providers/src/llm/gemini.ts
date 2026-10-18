import { GoogleGenAI } from "@google/genai";
import type { LlmJsonRequest, LlmProvider, ProviderCredentials, ProviderFactory, ProviderResult } from "@lvs/shared";
import { extractJsonText, zodToProviderSchema } from "../jsonschema.js";
import { toBase64 } from "../http.js";

export const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";

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
  };
}

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
    const call = buildGeminiJsonCall(req, this.defaultModel);
    const res = await this.ai.models.generateContent(call);
    return mapGeminiJsonResponse(res as GeminiLikeResponse, req);
  }
}

export const geminiLlmFactory: ProviderFactory<LlmProvider> = {
  id: "gemini",
  displayName: "Google Gemini",
  requiresApiKey: true,
  create: (creds) => new GeminiLlmProvider(creds),
};
