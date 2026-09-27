import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { modelInfoEndpoint } from "./config.ts";
import { extractJwtClaim } from "./keycloak.ts";

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
    /** per-token 成本（DB 实配；缺失保持 0——网关实测存在部分配置的 deployment） */
    input_cost_per_token?: number | null;
    output_cost_per_token?: number | null;
    cache_read_input_token_cost?: number | null;
    cache_creation_input_token_cost?: number | null;
    /** 网关声明的完整档位集（v0.12.0 回落链第一级） */
    reasoning_effort_levels?: string[] | null;
    /** per-level 布尔（回落链第二级）：LiteLLM 仅对非默认档暴露布尔
     *  （none/minimal/low/xhigh/max；medium/high 是默认档无布尔），其中只有
     *  xhigh/max 影响 thinkingLevelMap 产物，none 是 off 档（红线恒省略）不读 */
    supports_xhigh_reasoning_effort?: boolean | null;
    supports_max_reasoning_effort?: boolean | null;
  };
}

/** Models known to emit thinking blocks on the /v1/messages protocol leg. */
const REASONING_MODEL_PATTERN = /^(?:claude-|kimi[-/]|glm-|zai\/glm-|deepseek-|k3$|llm-)/;

/** supported_openai_params 中表明模型可推理的参数名（OpenAI reasoning_effort / Anthropic thinking）。 */
const REASONING_PARAM_NAMES = new Set(["reasoning_effort", "thinking"]);

/**
 * 推理模型的 thinking 配置：声明 max 级别 + 走 anthropic adaptive thinking 腿。
 *
 * - thinkingLevelMap 只列 max：off/minimal/low/medium/high 在 pi 的
 *   getSupportedThinkingLevels 里默认可选（非 xhigh/max 级别默认返回 true），
 *   xhigh 不声明（litellm 后端均不支持，pi-ai 内置 zai/kimi catalog 亦无 xhigh）。
 * - ⚠️ off 必须保持省略，切勿“补全”为 off: null：pi 序列化器依赖
 *   thinkingLevelMap?.off !== null 才发送 thinking:{type:"disabled"}——若声明
 *   off: null，disabled 通道静默关闭，所有依赖显式关思考的调用方全部遭殃
 *   （pi 会话级 off、auto-mode 扩展的分类器 thinkingEnabled:false、CC 式
 *   小预算分类调用）。实测：2026-08-26 thinking:{type:"disabled"} 经本网关
 *   送达 GLM 后端并降为 effort low 轻思考（取证见 相关研究笔记
 *   thinking-param-blackhole）。
 * - minimal/low/medium/high 省略 = 走 pi 通用 switch（minimal/low→low、
 *   medium→medium、high→high）作为 output_config.effort 发送：对真 Claude
 *   后端（low/medium/high 均为原生档位）现状即正确；GLM 后端实际仅
 *   low/high/max（medium 服务端转 high，BigModel 官方映射表），如需保真
 *   可按模型族显式声明，但需避开对 claude 族的重映射。
 * - compat.forceAdaptiveThinking 让 anthropic-messages 腿走 adaptive 分支，effort
 *   经 output_config.effort 传给网关；否则走 budget-based，max 被 clampReasoning
 *   压到 high、effort 不传递，max 沦为 UI 摆设。
 * - 实测（2026-08-24）litellm glm-5.2 adaptive+effort=max 比 high 多约 70% 思考量
 *   （679 vs 395 字符）；k3 / kimi-k2.7-code / kimi/k3 / claude-sonnet-5 同样接受
 *   adaptive+max。其余模型为限流/权限无法实测，但网关对 adaptive 格式无拒绝
 *   （最坏情况后端不思考，不报错）。
 */
const ADAPTIVE_THINKING: Pick<ProviderModelConfig, "thinkingLevelMap" | "compat"> = {
  thinkingLevelMap: { max: "max" },
  compat: { forceAdaptiveThinking: true },
};

/** supported_openai_params 是否声明了推理参数（研究 04：比名字正则更直接的能力信号）。 */
function hasReasoningParam(params: string[] | null | undefined): boolean {
  return Array.isArray(params) && params.some((p) => REASONING_PARAM_NAMES.has(p));
}

/**
 * 从 deployment 的 model_info 解析档位集（v0.12.0 回落链的档位数据级）：
 * `reasoning_effort_levels`（完整档集，优先）> per-level 布尔拼装（xhigh/max 布尔
 * 叠加在 pi 默认档 minimal~high 之上）。均缺失返回 null（落能力声明链）。
 * `none` 是档位集合法成员——参与交集与 off 判定（levels 含 none = 后端支持关思考）；
 * 但不作为 pi 思考级别枚举输出（off 由 thinkingLevelMap.off 单独表达）。
 */
function resolveEffortLevels(
  info: NonNullable<Pick<LiteLLMDeploymentEntry, "model_info">["model_info"]>,
): string[] | null {
  const levels = info.reasoning_effort_levels;
  if (Array.isArray(levels) && levels.length > 0) return levels;
  const xhigh = info.supports_xhigh_reasoning_effort === true;
  const max = info.supports_max_reasoning_effort === true;
  if (xhigh || max) {
    const set = ["minimal", "low", "medium", "high"];
    if (xhigh) set.push("xhigh");
    if (max) set.push("max");
    return set;
  }
  return null;
}

/** pi 思考级别菜单中需要 thinkingLevelMap 显式声明的 edge 档（其余默认可选）。 */
const EDGE_THINKING_LEVELS = new Set(["xhigh", "max"]);

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
  ...ADAPTIVE_THINKING,
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
  const merged = new Map<
    string,
    {
      maxInput?: number;
      maxOutput?: number;
      vision: boolean;
      sawReasoningTrue: boolean;
      sawReasoningFalse: boolean;
      sawReasoningUndeclared: boolean;
      reasoningParam: boolean;
      effortLevels: string[] | null;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }
  >();
  for (const entry of data ?? []) {
    const name = entry.model_name;
    if (!name || HIDDEN_NAME_PATTERN.test(name)) continue;
    const info = entry.model_info ?? {};
    if (info.mode && NON_CHAT_MODES.has(info.mode)) continue;

    const agg = merged.get(name) ?? {
      vision: true,
      sawReasoningTrue: false,
      sawReasoningFalse: false,
      sawReasoningUndeclared: false,
      reasoningParam: false,
      effortLevels: null,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    agg.maxInput ??= info.max_input_tokens ?? undefined;
    agg.maxOutput ??= info.max_output_tokens ?? undefined;
    // vision 聚合 all-true（C 项）：LiteLLM 同名组轮询，任一 deployment 非"显式 true"
    // （含未声明）即不宣传——轮到不支持的后端发图会 500
    agg.vision = agg.vision && info.supports_vision === true;
    // 成本按字段取 max：同名多 deployment 轮询时请求可能落到任一后端，取保守上界
    agg.cost.input = Math.max(agg.cost.input, info.input_cost_per_token ?? 0);
    agg.cost.output = Math.max(agg.cost.output, info.output_cost_per_token ?? 0);
    agg.cost.cacheRead = Math.max(agg.cost.cacheRead, info.cache_read_input_token_cost ?? 0);
    agg.cost.cacheWrite = Math.max(agg.cost.cacheWrite, info.cache_creation_input_token_cost ?? 0);
    // supports_reasoning 聚合三态（C 项）：任一 deployment 显式 false 一票否决；
    // 全部显式 true 才 true；其余（未声明混合 / 全未声明）为不确定 → 回落 params / 正则
    if (info.supports_reasoning === true) agg.sawReasoningTrue = true;
    else if (info.supports_reasoning === false) agg.sawReasoningFalse = true;
    else agg.sawReasoningUndeclared = true;
    // supported_openai_params 聚合：任一 deployment 含推理参数即 true（能力信号，any-true）
    agg.reasoningParam ||= hasReasoningParam(info.supported_openai_params);
    // 档位集聚合取交集（all-true 精神：只宣传轮询组全部 deployment 都支持的档位；
    // 某个 deployment 无任何档位声明 = 空集 → 交集为空，落三级链）
    const curLevels = resolveEffortLevels(info);
    agg.effortLevels =
      agg.effortLevels === null
        ? curLevels
        : curLevels === null
          ? []
          : agg.effortLevels.filter((l) => curLevels.includes(l));
    merged.set(name, agg);
  }

  const models = [...merged].map<ProviderModelConfig>(([id, agg]) => {
    // vision all-true 才宣传多模态（见聚合处注释）
    const input: ("text" | "image")[] = ["text"];
    if (agg.vision) input.push("image");
    // 推理能力四级回落链（v0.12.0，ADR 0001）：supports_reasoning 声明层三态 >
    // reasoning_effort_levels（档位存在即推理）> supported_openai_params > 名字正则
    const reasoningDeclared = agg.sawReasoningFalse
      ? false
      : agg.sawReasoningTrue && !agg.sawReasoningUndeclared
        ? true
        : undefined;
    const reasoning = reasoningDeclared
      ?? ((agg.effortLevels?.length ?? 0) > 0 || agg.reasoningParam || REASONING_MODEL_PATTERN.test(id));
    // thinkingLevelMap 来源分化（v0.12.0）：有精确档位时从 levels 生成 edge 声明
    // （xhigh/max，值=effort 直传；minimal~high 省略走 pi 默认拼写）；off 按据声明
    // （levels 无 none → off:null，见下方注释；无据时省略）。无档位声明维持 hack
    // 兜底 {max}。forceAdaptiveThinking 对所有推理模型保留——它是 effort 传递的
    // wire 通道（effort 值与档位枚举同构，budget 路径无法表达档位枚举；
    // downstream fork 2026-09-20 anthropic 端点实测 adaptive 形态被接受且 effort 语义生效）。
    let thinking: Pick<ProviderModelConfig, "thinkingLevelMap" | "compat"> | undefined;
    if (reasoning) {
      const levels = agg.effortLevels;
      let map: Record<string, string | null> | undefined;
      if (levels === null) {
        map = { max: "max" }; // 无档位声明 → hack 兜底（off 省略，维持现状）
      } else {
        const entries: [string, string | null][] = levels
          .filter((l) => EDGE_THINKING_LEVELS.has(l))
          .map((l) => [l, l]);
        // 后端不支持关思考（levels 无 none 档，如 glm-5.3 / kimi-k3 官方三档）声明
        // off:null——菜单层移除 off（pi getSupportedThinkingLevels 的 mapped===null
        // 排除）+ 序列化层不再发 thinking:{type:"disabled"}（对强制思考后端会 4xx）、
        // 显式 off 请求被 clamp 到最低档。v0.8.0 的 off:null "黑洞"陷阱只在**无依据
        // 盲目补全**时成立；网关 levels 无 none 正是依据。levels 含 none 时 off 省略
        // （后端支持关思考，默认可选）。
        if (!levels.includes("none")) entries.push(["off", null] as const);
        map = entries.length > 0 ? Object.fromEntries(entries) : undefined;
      }
      // pi 的 thinkingLevelMap 类型声明为 Record<string,string>，但运行时序列化器
      // 明确检查 `?.off !== null`（v0.8.0 取证）——null 是其支持的运行时形状，
      // 上游类型声明不完整，此处断言越过
      thinking = {
        ...(map ? { thinkingLevelMap: map as unknown as ProviderModelConfig["thinkingLevelMap"] } : {}),
        compat: ADAPTIVE_THINKING.compat,
      };
    }
    return {
      id,
      name: id,
      reasoning,
      input,
      cost: agg.cost,
      contextWindow: agg.maxInput ?? 200000,
      maxTokens: agg.maxOutput ?? 64000,
      // 非推理模型不加 thinkingLevelMap/compat（thinkingLevelMap 缺失时 pi 仅允许 off）
      ...(thinking ?? {}),
    };
  });

  return models.length > 0 ? models : null;
}

/**
 * 模型级 customer 头注入（呑底通道，配套 modifyModels 使用）：
 * 把从当前 credential JWT 解出的用户标识写进每个 model.headers。
 * before_provider_headers hook 只覆盖走会话主循环（sdk streamFn 带 transformHeaders）
 * 的请求；扩展用裸 pi-ai streamSimple 直接调 LLM 时（如 pi-observational-memory 的
 * observer/reflector/dropper）hook 不触发——但这些调用经 createClient 的
 * mergeClientHeaders 合并 model.headers，所以模型级 stamp 能覆盖到它们。
 * 纯函数：解不出 claim / 未配置 header 时原样返回，永不修改入参。
 */
export function stampCustomerHeader<T extends { headers?: Record<string, string> }>(
  models: T[],
  bearer: string | undefined,
  header: string,
  claims: string[],
): T[] {
  if (!header || !bearer) return models;
  const customerId = extractJwtClaim(bearer, claims);
  if (!customerId) return models;
  return models.map((m) => ({ ...m, headers: { ...m.headers, [header]: customerId } }));
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
