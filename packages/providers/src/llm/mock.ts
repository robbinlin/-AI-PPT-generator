import type { LlmJsonRequest, LlmProvider, ProviderFactory, ProviderResult } from "@lvs/shared";

export type MockLlmResponder = (req: { system: string; prompt: string; schemaName?: string }) => unknown;

/**
 * Deterministic LLM for tests. `respond` receives the prompt and returns the
 * JSON value to validate against the request schema. Records every call.
 */
export class MockLlmProvider implements LlmProvider {
  readonly id = "mock";
  readonly defaultModel = "mock-1";
  readonly calls: Array<{ system: string; prompt: string; attachments: number }> = [];

  constructor(private readonly respond: MockLlmResponder) {}

  async generateJson<T>(req: LlmJsonRequest<T>): Promise<ProviderResult<T>> {
    this.calls.push({ system: req.system, prompt: req.prompt, attachments: req.attachments?.length ?? 0 });
    const raw = this.respond({ system: req.system, prompt: req.prompt, schemaName: req.schema.description });
    const data = req.schema.parse(raw);
    const chars = req.system.length + req.prompt.length;
    return {
      data,
      usage: [
        { unit: "tokens_in", quantity: Math.ceil(chars / 4) },
        { unit: "tokens_out", quantity: Math.ceil(JSON.stringify(raw).length / 4) },
      ],
      providerRequestId: `mock-${this.calls.length}`,
    };
  }
}

export function mockLlmFactory(respond: MockLlmResponder): ProviderFactory<LlmProvider> {
  return { id: "mock", displayName: "Mock LLM", requiresApiKey: false, create: () => new MockLlmProvider(respond) };
}
