import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { modelsEndpoint } from "./config.ts";

interface LiteLLMModel {
  id: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

/** Models known to emit thinking blocks on the /v1/messages protocol leg. */
const REASONING_MODEL_PATTERN = /^(claude-|kimi-|glm-|zai\/glm-|deepseek-)/;

const FALLBACK_MODELS: ProviderModelConfig[] = [
  { id: "claude-opus-5", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-fable-5", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-opus-4-8", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-opus-4-7", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-4-6", contextWindow: 1000000, maxTokens: 64000 },
  { id: "claude-haiku-4-5-20251001", contextWindow: 200000, maxTokens: 64000 },
  { id: "kimi-k2.7-code", contextWindow: 262144, maxTokens: 131072 },
  { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 8192 },
  { id: "zai/glm-4.7", contextWindow: 200000, maxTokens: 128000 },
].map((m) => ({
  id: m.id,
  name: m.id,
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
}));

export function fallbackModels(): ProviderModelConfig[] {
  return FALLBACK_MODELS;
}

/** Fetch chat models from the gateway. Returns null on auth failure or network error. */
export async function fetchGatewayModels(bearerToken: string): Promise<ProviderModelConfig[] | null> {
  try {
    const response = await fetch(modelsEndpoint, {
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { data?: LiteLLMModel[] };
    const models = (payload.data ?? [])
      .filter((m) => m.mode === "chat")
      .filter((m) => !m.id.endsWith("-openai") && !m.id.startsWith("staging/"))
      .map<ProviderModelConfig>((m) => ({
        id: m.id,
        name: m.id,
        reasoning: REASONING_MODEL_PATTERN.test(m.id),
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.max_input_tokens ?? 200000,
        maxTokens: m.max_output_tokens ?? 64000,
      }));

    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}
