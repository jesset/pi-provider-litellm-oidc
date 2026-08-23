import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { modelInfoEndpoint } from "./config.ts";

/** /model/info 返回的 deployment 级条目（只取关心的字段；同名多 deployment 多行） */
interface LiteLLMDeploymentEntry {
  model_name?: string;
  model_info?: {
    mode?: string | null;
    max_input_tokens?: number | null;
    max_output_tokens?: number | null;
    supports_vision?: boolean | null;
    /** 网关实配的推理能力声明（研究 04：47/53 可见部署有值）。优先于名字正则。 */
    supports_reasoning?: boolean | null;
    /** 网关声明的 OpenAI 参数白名单；含 reasoning_effort / thinking 即可推理（研究 04 bonus）。 */
    supported_openai_params?: string[] | null;
  };
}

/** Models known to emit thinking blocks on the /v1/messages protocol leg. */
const REASONING_MODEL_PATTERN = /^(?:claude-|kimi[-/]|glm-|zai\/glm-|deepseek-|k3$|llm-)/;

/** supported_openai_params 中表明模型可推理的参数名（OpenAI reasoning_effort / Anthropic thinking）。 */
const REASONING_PARAM_NAMES = new Set(["reasoning_effort", "thinking"]);

/** supported_openai_params 是否声明了推理参数（研究 04：比名字正则更直接的能力信号）。 */
function hasReasoningParam(params: string[] | null | undefined): boolean {
  return Array.isArray(params) && params.some((p) => REASONING_PARAM_NAMES.has(p));
}

/**
 * /model/info 显式声明的非 chat 模式，直接排除。
 * mode 缺失是自研/别名模型的常态（LiteLLM 静态 cost map 查不到公开名），
 * 不据此排除——那会把大量实际可对话的模型误滤掉。
 */
const NON_CHAT_MODES = new Set(["embedding", "rerank", "image_generation"]);

/**
 * 隐藏内部噪音条目（产品选择，非可调性问题）：
 * - staging/ 前缀：网关内部后端命名空间，与公开别名指向同一批后端
 * - -openai 后缀：OpenAI 协议腿孪生，与 anthropic 腿功能重复
 */
const HIDDEN_NAME_PATTERN = /(^staging\/)|(-openai$)/i;

const FALLBACK_MODELS: ProviderModelConfig[] = [
  { id: "claude-opus-5", contextWindow: 1048576, maxTokens: 131072, vision: false },
  { id: "claude-fable-5", contextWindow: 1048576, maxTokens: 131072, vision: false },
  { id: "claude-opus-4-8", contextWindow: 1048576, maxTokens: 131072, vision: false },
  { id: "claude-opus-4-7", contextWindow: 1048576, maxTokens: 131072, vision: false },
  { id: "claude-opus-4-6", contextWindow: 1048576, maxTokens: 131072, vision: false },
  { id: "claude-sonnet-5", contextWindow: 1048576, maxTokens: 131072, vision: true },
  { id: "claude-sonnet-4-6", contextWindow: 1048576, maxTokens: 131072, vision: true },
  { id: "claude-haiku-4-5-20251001", contextWindow: 200000, maxTokens: 64000, vision: false },
  { id: "kimi-k2.7-code", contextWindow: 200000, maxTokens: 131072, vision: true },
  { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 8192, vision: false },
  { id: "zai/glm-4.7", contextWindow: 200000, maxTokens: 128000, vision: false },
].map((m) => ({
  id: m.id,
  name: m.id,
  reasoning: true,
  input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
}));

export function fallbackModels(): ProviderModelConfig[] {
  return FALLBACK_MODELS;
}

/**
 * Fetch chat models from the gateway's /model/info (deployment 级配置)。
 * 不用 /v1/models：其 mode/max_tokens 来自 LiteLLM 静态 cost map 按公开名查找
 * （v1.95.0 proxy/utils.py create_model_info_response），自研/别名模型一律缺失，
 * alias 名返回的是"这个名字在静态表里的参数"而非网关实际部署参数。
 * /model/info 返回 DB 实配值（token limits、supports_vision），需网关将其列入
 * public_routes（LiteLLM 已配置）。
 * Returns null on auth failure, network error, or abort.
 */
/**
 * 把 /model/info 的 deployment 级条目转成 ProviderModelConfig[]（纯函数，无网络）。
 * 按 model_name 聚合同名多 deployment；字段取第一个非空值（首个 deployment 缺配时
 * 后续可补全），vision / reasoning 任一 deployment 声明即认为支持。
 * 空 data 或全被过滤时返回 null（触发上层回落 stored / fallback）。
 */
export function transformModelInfo(data: LiteLLMDeploymentEntry[] | undefined): ProviderModelConfig[] | null {
  const merged = new Map<string, { maxInput?: number; maxOutput?: number; vision: boolean; reasoningDeclared?: boolean; reasoningParam: boolean }>();
  for (const entry of data ?? []) {
    const name = entry.model_name;
    if (!name || HIDDEN_NAME_PATTERN.test(name)) continue;
    const info = entry.model_info ?? {};
    if (info.mode && NON_CHAT_MODES.has(info.mode)) continue;

    const agg = merged.get(name) ?? { vision: false, reasoningParam: false };
    agg.maxInput ??= info.max_input_tokens ?? undefined;
    agg.maxOutput ??= info.max_output_tokens ?? undefined;
    agg.vision ||= info.supports_vision === true;
    // supports_reasoning 聚合：任一 deployment 声明 true 即 true（与 vision 同语义）；
    // 全部显式 false 才 false；未声明（null/缺失）保持 undefined，留给 params / 正则回落
    if (info.supports_reasoning === true) agg.reasoningDeclared = true;
    else if (info.supports_reasoning === false && agg.reasoningDeclared == null) agg.reasoningDeclared = false;
    // supported_openai_params 聚合：任一 deployment 含推理参数即 true（能力信号，any-true）
    agg.reasoningParam ||= hasReasoningParam(info.supported_openai_params);
    merged.set(name, agg);
  }

  const models = [...merged].map<ProviderModelConfig>(([id, agg]) => {
    // 未声明 supports_vision 的按纯文本处理：向非多模态后端发图会 500
    const input: ("text" | "image")[] = ["text"];
    if (agg.vision) input.push("image");
    return {
      id,
      name: id,
      // 推理能力优先级：网关 supports_reasoning 声明 > supported_openai_params 推理参数 > 名字正则
      reasoning: agg.reasoningDeclared ?? (agg.reasoningParam || REASONING_MODEL_PATTERN.test(id)),
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: agg.maxInput ?? 200000,
      maxTokens: agg.maxOutput ?? 64000,
    };
  });

  return models.length > 0 ? models : null;
}

export async function fetchGatewayModels(bearerToken: string, signal?: AbortSignal): Promise<ProviderModelConfig[] | null> {
  try {
    // 15s 本地超时；传入框架共享 abort signal 时任一触发即取消
    // （框架侧取消——如登录后目录刷新超时——应立即中断，而非占用 socket 到本地超时）
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(modelInfoEndpoint, {
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { data?: LiteLLMDeploymentEntry[] };
    return transformModelInfo(payload.data);
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
