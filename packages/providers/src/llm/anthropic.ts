import Anthropic from "@anthropic-ai/sdk";
import type { LlmJsonRequest, LlmProvider, ProviderCredentials, ProviderFactory, ProviderResult } from "@lvs/shared";
import { extractJsonText, zodToProviderSchema } from "../jsonschema.js";
import { toBase64 } from "../http.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

type ImageMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Build the Messages API request. We use structured outputs
 * (`output_config.format`) rather than forced tool use, which current models reject.
 */
export function buildAnthropicJsonParams<T>(
  req: LlmJsonRequest<T>,
  defaultModel = ANTHROPIC_DEFAULT_MODEL,
): Anthropic.MessageCreateParamsNonStreaming {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const a of req.attachments ?? []) {
    if (a.label) content.push({ type: "text", text: `[${a.label}]` });
    if (a.mimeType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(a.data) } });
    } else if (a.mimeType.startsWith("image/")) {
      content.push({ type: "image", source: { type: "base64", media_type: a.mimeType as ImageMedia, data: toBase64(a.data) } });
    } else {
      content.push({ type: "text", text: `[unsupported attachment ${a.mimeType}]` });
    }
  }
  content.push({ type: "text", text: req.prompt });
  return {
    model: req.model ?? defaultModel,
    max_tokens: req.maxOutputTokens ?? 16_000,
    system: req.system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: zodToProviderSchema(req.schema, { closedObjects: true, strip: ["default"] }) } },
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

export interface AnthropicLikeResponse {
  id?: string;
  stop_reason?: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function mapAnthropicJsonResponse<T>(res: AnthropicLikeResponse, req: LlmJsonRequest<T>): ProviderResult<T> {
  if (res.stop_reason === "refusal") throw new Error("anthropic: request was refused by safety classifiers");
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (!text.trim()) throw new Error("anthropic returned no text content");
  const data = req.schema.parse(JSON.parse(extractJsonText(text)));
  return {
    data,
    usage: [
      { unit: "tokens_in", quantity: res.usage?.input_tokens ?? 0 },
      { unit: "tokens_out", quantity: res.usage?.output_tokens ?? 0 },
    ],
    ...(res.id ? { providerRequestId: res.id } : {}),
  };
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly defaultModel: string;
  private readonly client: Anthropic;

  constructor(creds: ProviderCredentials, defaultModel = ANTHROPIC_DEFAULT_MODEL) {
    if (!creds.apiKey) throw new Error("anthropic: apiKey required");
    this.client = new Anthropic({ apiKey: creds.apiKey, ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}) });
    this.defaultModel = defaultModel;
  }

  async generateJson<T>(req: LlmJsonRequest<T>): Promise<ProviderResult<T>> {
    const params = buildAnthropicJsonParams(req, this.defaultModel);
    const res = await this.client.messages.create(params);
    return mapAnthropicJsonResponse(res as AnthropicLikeResponse, req);
  }
}

export const anthropicLlmFactory: ProviderFactory<LlmProvider> = {
  id: "anthropic",
  displayName: "Anthropic Claude",
  requiresApiKey: true,
  create: (creds) => new AnthropicLlmProvider(creds),
};
