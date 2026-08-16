import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
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

/** Fetch chat models from the gateway. Returns null on auth failure, network error, or abort. */
export async function fetchGatewayModels(bearerToken: string, signal?: AbortSignal): Promise<ProviderModelConfig[] | null> {
  try {
    // 15s 本地超时；传入框架共享 abort signal 时任一触发即取消
    // （框架侧取消——如登录后目录刷新超时——应立即中断，而非占用 socket 到本地超时）
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(modelsEndpoint, {
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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

/**
 * 从持久化目录条目（models-store.json，由本扩展网络刷新成功时 publish 的
 * persist 写入）恢复模型列表，供离线阶段与网络失败时回落，避免退回静态列表。
 * 条目运行时形状即 ProviderModelConfig[]，Model -> ProviderModelConfig 为结构子集。
 */
export function storedModels(stored: Readonly<ModelsStoreEntry> | undefined): ProviderModelConfig[] | undefined {
  const models = stored?.models;
  if (!models || models.length === 0) return undefined;
  return models.slice() as ProviderModelConfig[];
}
