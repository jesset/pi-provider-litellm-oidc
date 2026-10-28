import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { trimTrailingSlash } from "./config.ts";
import type { InstanceConfig } from "./config.ts";
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
    /** 网关声明的完整档位集（v0.10.0 回落链第一级） */
    reasoning_effort_levels?: string[] | null;
    /** per-level 布尔（回落链第二级）：LiteLLM 仅对 none/minimal/low/xhigh/max
     *  暴露布尔（medium/high 是默认档无布尔）。此处 opt-in 读取三个解锁性布尔
     *  （none→off 可选、xhigh/max→edge 档可选）；minimal/low 的 opt-out false
     *  排除精度留给 levels 声明，拼装级不读 */
    supports_none_reasoning_effort?: boolean | null;
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
 * - ⚠️ 兜底路径的 off 保持省略（本常量不声明 off 键）：未声明档位时后端的
 *   关思考能力未知，走 pi 默认（off 可选、发 thinking:{type:"disabled"}）最
 *   保守。有档位声明后 off 按档集处置（含 none → off:"off"，不含 → off:null
 *   不发 disabled，见 transformModelInfo 与 ADR 0001）——pi 序列化器依赖
 *   thinkingLevelMap?.off !== null 才发 disabled，v0.8.0 取证的 off:null
 *   "黑洞"陷阱仅在无据盲目补全时成立（相关研究笔记
 *   thinking-param-blackhole；实测 disabled 经本网关送达 GLM 后端
 *   降为 effort low 轻思考）。
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
 * - LiteLLM anthropic 腿桥接行为（v1.100.1 源码核实，litellm/llms/anthropic/
 *   experimental_pass_through/adapters/transformation.py，自 downstream fork
 *   研究吸收）：非 Claude 后端 thinking → reasoning_effort，adaptive 默认
 *   medium 但 output_config.effort 覆盖（effort=max → reasoning_effort=max）；
 *   后端 reasoning_content 回译为 anthropic thinking 块（含流式 thinking_delta）。
 */
const ADAPTIVE_THINKING: Pick<Extract<ProviderModelConfig, { type?: "chat" }>, "thinkingLevelMap" | "compat"> = {
  thinkingLevelMap: { max: "max" },
  compat: { forceAdaptiveThinking: true },
};

/** supported_openai_params 是否声明了推理参数（研究 04：比名字正则更直接的能力信号）。 */
function hasReasoningParam(params: string[] | null | undefined): boolean {
  return Array.isArray(params) && params.some((p) => REASONING_PARAM_NAMES.has(p));
}

/**
 * pi 思考级别七档 ↔ 网关档位（LiteLLM `REASONING_EFFORT`，types/llms/openai.py）
 * 的对照表，唯一命名差异是网关 `none` ↔ pi `off`。档位解析与菜单精确对齐
 * （v0.10.1，ADR 0001）的全部档位视图从此派生；档位集之外的未知档名忽略——
 * LiteLLM 对未知 level 同样丢弃而非报错（router_utils/reasoning_effort_capability.py）。
 */
const THINKING_LEVEL_TABLE: ReadonlyArray<{
  /** pi 菜单档名 */
  pi: string;
  /** 网关 `reasoning_effort_levels` 档名 */
  gateway: string;
  /** edge=true：pi 要求 thinkingLevelMap 显式声明才可选（xhigh/max），其余默认可选 */
  edge: boolean;
}> = [
  { pi: "off", gateway: "none", edge: false },
  { pi: "minimal", gateway: "minimal", edge: false },
  { pi: "low", gateway: "low", edge: false },
  { pi: "medium", gateway: "medium", edge: false },
  { pi: "high", gateway: "high", edge: false },
  { pi: "xhigh", gateway: "xhigh", edge: true },
  { pi: "max", gateway: "max", edge: true },
];

/** 网关档位全集（未知档名过滤依据）。 */
const KNOWN_EFFORT_LEVELS = new Set(THINKING_LEVEL_TABLE.map((e) => e.gateway));

/** pi 默认可选（非 edge）的思考级别。精确对齐时按 pi↔gateway 名声明自身值或 null 排除。 */
const DEFAULT_THINKING_LEVELS = THINKING_LEVEL_TABLE.filter((e) => !e.edge);

/** pi 要求 thinkingLevelMap 显式声明才可选的 edge 思考级别。 */
const EDGE_THINKING_LEVELS = THINKING_LEVEL_TABLE.filter((e) => e.edge);

/**
 * 从 deployment 的 model_info 解析档位集（v0.10.0 回落链的档位数据级）：
 * `reasoning_effort_levels`（完整档集，优先）> per-level 布尔拼装。均缺失（或
 * levels 过滤未知档后为空）返回 null（落能力声明链）。`none` 是档位集合法
 * 成员——参与交集与 off 判定（levels 含 none = 后端支持关思考）。
 */
function resolveEffortLevels(
  info: NonNullable<Pick<LiteLLMDeploymentEntry, "model_info">["model_info"]>,
): string[] | null {
  const levels = info.reasoning_effort_levels;
  if (Array.isArray(levels) && levels.length > 0) {
    const known = levels.filter((l) => KNOWN_EFFORT_LEVELS.has(l));
    if (known.length > 0) return known;
    // 全为未知档名 → 视同未声明，继续走布尔拼装级（"未知档名忽略"）
  }
  // 布尔拼装级（levels 缺失时的近似）：minimal~high 恒含（LiteLLM：medium/high
  // 无条件、minimal/low 为 opt-out 默认含——false 排除的精度留给 levels 声明）；
  // none/xhigh/max 三个解锁性布尔 opt-in 读取（=== true 才含。none 不照搬
  // LiteLLM 的 opt-out 默认含：对强制思考后端错误宣称支持关思考会 4xx，宁缺
  // 勿滥）。levels 才是 wins whole 的权威声明（ADR 0001）。
  const none = info.supports_none_reasoning_effort === true;
  const xhigh = info.supports_xhigh_reasoning_effort === true;
  const max = info.supports_max_reasoning_effort === true;
  if (none || xhigh || max) {
    const set = DEFAULT_THINKING_LEVELS.filter((e) => e.gateway !== "none").map((e) => e.gateway);
    if (none) set.unshift("none");
    if (xhigh) set.push("xhigh");
    if (max) set.push("max");
    return set;
  }
  return null;
}

/**
 * /model/info 显式声明的图像类模式：分流为 pi image 模型条目（spec: issue #1）。
 * image_edit 部署标示支持图像输入（图生图/局部编辑），与 generation 同名时聚为一条、input 取并集。
 */
const IMAGE_MODES = new Set(["image_generation", "image_edit"]);

/**
 * decisions 类模式：分流为 pi classifier 模型条目。`evaluation` 是 LiteLLM 的同义
 * mode（types/utils.py 的 decision 谓词为 mode in ("decisions", "evaluation")，
 * v1.106.4 源码核实）——jev 系部署实际标 evaluation，两者都认。
 */
const DECISION_MODES = new Set(["decisions", "evaluation"]);

/**
 * 显式剔除的其余非 chat 模式（pi 无对应 ModelType/消费通道，spec out of scope）。
 * 未知 mode 值不剔除——与 mode 缺失同精神（自研/别名模型常态，不误杀）。
 */
const EXCLUDED_MODES = new Set([
  "embedding",
  "rerank",
  "audio_transcription",
  "audio_speech",
  "video_generation",
  "realtime",
  "batch",
  "ocr",
]);

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

export function fallbackModels(instance?: Pick<InstanceConfig, "fallbackModels">): ProviderModelConfig[] {
  return instance?.fallbackModels ?? FALLBACK_MODELS;
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
type CostAggregate = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * per-token 成本换算聚合：网关 input_cost_per_token 等字段为 USD/token，pi 的 ModelCost
 * 为 USD/百万 token（pi-ai model-schema 明示）——聚合时统一换算单位后取 max（单调变换
 * 保序，max 语义不变）。同名多 deployment 轮询时取保守上界。
 */
function aggregateCost(cost: CostAggregate, info: NonNullable<Pick<LiteLLMDeploymentEntry, "model_info">["model_info"]>): void {
  cost.input = Math.max(cost.input, (info.input_cost_per_token ?? 0) * 1_000_000);
  cost.output = Math.max(cost.output, (info.output_cost_per_token ?? 0) * 1_000_000);
  cost.cacheRead = Math.max(cost.cacheRead, (info.cache_read_input_token_cost ?? 0) * 1_000_000);
  cost.cacheWrite = Math.max(cost.cacheWrite, (info.cache_creation_input_token_cost ?? 0) * 1_000_000);
}

const ZERO_COST: CostAggregate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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
      cost: CostAggregate;
    }
  >();
  // 非 chat 模态分桶（spec: issue #1）：图像桶（同名 generation+edit 聚合，edit 标示图像输入）、
  // decisions 桶（同名聚合取首个非空 token 上限）。同名跨桶（如同名 chat+image 部署）
  // 在实际 LiteLLM 配置中不存在；若出现则各自成条，行为可解释。
  const imageAgg = new Map<string, { edit: boolean; cost: CostAggregate }>();
  const decisionAgg = new Map<string, { maxInput?: number; cost: CostAggregate }>();
  for (const entry of data ?? []) {
    const name = entry.model_name;
    if (!name || HIDDEN_NAME_PATTERN.test(name)) continue;
    const info = entry.model_info ?? {};
    const mode = info.mode ?? null;
    if (mode && IMAGE_MODES.has(mode)) {
      const agg = imageAgg.get(name) ?? { edit: false, cost: { ...ZERO_COST } };
      agg.edit ||= mode === "image_edit";
      aggregateCost(agg.cost, info);
      imageAgg.set(name, agg);
      continue;
    }
    if (mode && DECISION_MODES.has(mode)) {
      const agg = decisionAgg.get(name) ?? { cost: { ...ZERO_COST } };
      agg.maxInput ??= info.max_input_tokens ?? undefined;
      aggregateCost(agg.cost, info);
      decisionAgg.set(name, agg);
      continue;
    }
    if (mode && EXCLUDED_MODES.has(mode)) continue;

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
    // 成本按字段换算 per-million 后取 max（同名多 deployment 轮询，取保守上界）
    aggregateCost(agg.cost, info);
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
    // 推理能力四级回落链（v0.10.0，ADR 0001）：supports_reasoning 声明层三态 >
    // reasoning_effort_levels（档位存在即推理）> supported_openai_params > 名字正则
    const reasoningDeclared = agg.sawReasoningFalse
      ? false
      : agg.sawReasoningTrue && !agg.sawReasoningUndeclared
        ? true
        : undefined;
    const reasoning = reasoningDeclared
      ?? ((agg.effortLevels?.length ?? 0) > 0 || agg.reasoningParam || REASONING_MODEL_PATTERN.test(id));
    // thinkingLevelMap 来源分化（v0.10.0）：无档位声明维持档位兜底 {max}；有精确
    // 档位时菜单精确对齐（v0.10.1，ADR 0001）——map 是网关档集的镜像：
    // - 档集内的档声明为自身值：选什么发什么 effort（minimal 直传，不再走 pi 序列化
    //   switch 的 minimal→low claude 族近似——那是无声明场景的兜底）；off 走
    //   disabled 通道不涉及 effort 值
    // - 档集外的默认可选档（off/minimal/low/medium/high）以 null 显式排除：pi
    //   getSupportedThinkingLevels 的 mapped===null 是通用菜单排除机制（非 off 专属），
    //   排除后选不到、序列化层走不到（残留值经 clampThinkingLevel 调到最近可用档）
    // - edge 档（xhigh/max）pi 要求显式声明才可选：档集含则声明自身，不含则不声明
    //   （天然不可选，无需 null）
    // - 网关 none 档即 pi 的 off：档集含 none → off:"off"（序列化器只检查
    //   off !== null 才发 thinking:{type:"disabled"}，字符串值即可）；不含 → off:null
    //   （不发 disabled——对强制思考后端会 4xx，显式 off 请求 clamp 到最低档）。
    //   v0.8.0 的 off:null "黑洞"陷阱只在无据盲目补全时成立，档集声明正是依据
    // - 同名组档位交集为空视同未声明（回落兜底）：档位声明不相交几乎必然是网关配置
    //   错误，砍到只剩 off 比维持兜底伤害更大
    // forceAdaptiveThinking 对所有推理模型保留——它是 effort 传递的 wire 通道
    // （effort 值与档位枚举同构，budget 路径无法表达档位枚举；downstream fork
    // 2026-09-20 anthropic 端点实测 adaptive 形态被接受且 effort 语义生效）。
    let thinking: Pick<Extract<ProviderModelConfig, { type?: "chat" }>, "thinkingLevelMap" | "compat"> | undefined;
    if (reasoning) {
      const levels = agg.effortLevels;
      let map: Record<string, string | null>;
      if (!levels || levels.length === 0) {
        map = { max: "max" }; // 无档位声明（或同名组交集为空）→ 档位兜底（off 省略，维持现状）
      } else {
        const entries: [string, string | null][] = DEFAULT_THINKING_LEVELS.map(({ pi, gateway }) =>
          levels.includes(gateway) ? [pi, pi] : [pi, null],
        );
        for (const { pi } of EDGE_THINKING_LEVELS) {
          if (levels.includes(pi)) entries.push([pi, pi]);
        }
        map = Object.fromEntries(entries);
      }
      // pi 的 thinkingLevelMap 类型声明为 Record<string,string>，但运行时序列化器
      // 明确检查 `?.off !== null`（v0.8.0 取证）——null 是其支持的运行时形状，
      // 上游类型声明不完整，此处断言越过
      thinking = {
        thinkingLevelMap: map as unknown as Extract<ProviderModelConfig, { type?: "chat" }>["thinkingLevelMap"],
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

  const imageModels = [...imageAgg].map<ProviderModelConfig>(([id, agg]) => ({
    type: "image",
    id,
    name: id,
    api: "litellm-images",
    input: agg.edit ? (["text", "image"] as const) : (["text"] as const),
    output: ["image"] as const,
    cost: agg.cost,
  }));
  const decisionModels = [...decisionAgg].map<ProviderModelConfig>(([id, agg]) => ({
    type: "classifier",
    id,
    name: id,
    api: "litellm-decisions",
    input: ["text"] as const,
    contextWindow: agg.maxInput ?? 65536,
    cost: agg.cost,
  }));

  const total = models.length + imageModels.length + decisionModels.length;
  return total > 0 ? [...models, ...imageModels, ...decisionModels] : null;
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

export async function fetchGatewayModels(instance: InstanceConfig, bearerToken: string, signal?: AbortSignal): Promise<ProviderModelConfig[] | null> {
  try {
    // 15s 本地超时；传入框架共享 abort signal 时任一触发即取消
    // （框架侧取消——如登录后目录刷新超时——应立即中断，而非占用 socket 到本地超时）
    const timeout = AbortSignal.timeout(15000);
    const baseUrl = trimTrailingSlash(instance.gatewayBaseUrl);
    const response = await fetch(`${baseUrl}${instance.modelInfoPath}`, {
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
