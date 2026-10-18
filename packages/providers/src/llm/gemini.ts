import { GoogleGenAI } from "@google/genai";
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
    const models = [req.model ?? this.defaultModel, ...envFallbackModels().filter((m) => m !== (req.model ?? this.defaultModel))];
    let lastErr: unknown;
    for (const model of models) {
      for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
        try {
          const call = buildGeminiJsonCall({ ...req, model }, this.defaultModel);
          const res = await this.ai.models.generateContent(call);
          return mapGeminiJsonResponse(res as GeminiLikeResponse, req);
        } catch (err) {
          lastErr = err;
          const status = geminiErrorStatus(err);
          // 429 with a daily quota exhausted or any non-transient error: do not hammer the model.
          if (!(status === 503 || status === 429 || status === 500)) throw err;
          if (status === 429 && /per.?day|PerDay/i.test(String(err))) break;
          if (attempt < GEMINI_MAX_ATTEMPTS - 1) await sleep(Math.min(30_000, 2_000 * 2 ** attempt) + Math.random() * 1_000);
        }
      }
    }
    throw lastErr;
  }
}

const GEMINI_MAX_ATTEMPTS = 4;
/** Models tried in order when the primary one is overloaded (503) or rate limited. */
const envFallbackModels = () =>
  (process.env.GEMINI_LLM_FALLBACK_MODELS ?? "gemini-3.5-flash")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

function geminiErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; message?: string };
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.code === "number") return e.code;
  const m = /"code":\s*(\d{3})/.exec(e?.message ?? "");
  return m ? Number(m[1]) : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const geminiLlmFactory: ProviderFactory<LlmProvider> = {
  id: "gemini",
  displayName: "Google Gemini",
  requiresApiKey: true,
  create: (creds) => new GeminiLlmProvider(creds, envLlmModel()),
};
