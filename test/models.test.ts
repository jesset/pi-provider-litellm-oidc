import { describe, expect, it } from "bun:test";
import { fallbackModels, stampCustomerHeader, transformModelInfo } from "../extension/models.ts";
import { makeJwt, opaqueToken } from "./helpers.ts";

/** 把结果按 id 索引，断言不依赖数组顺序（Map 按首次出现顺序，但测试应稳）。 */
function byId(models: ReturnType<typeof transformModelInfo>): Record<string, NonNullable<typeof models>[number]> {
  const map: Record<string, NonNullable<typeof models>[number]> = {};
  for (const m of models ?? []) map[m.id] = m;
  return map;
}

/**
 * transformModelInfo：把 /model/info 的 deployment 级条目转成 ProviderModelConfig[]。
 * Cycle 1 锁定现有行为（隐藏过滤、非 chat 模式过滤、同名聚合、vision、默认值、regex 推理）——
 * 这些条目故意不含 supports_reasoning，使当前 regex 行为与新行为一致。
 */
describe("transformModelInfo — 现有行为锁定", () => {
  it("过滤 staging/ 前缀与 -openai 后缀的内部噪音条目", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { mode: "chat" } },
      { model_name: "staging/internal-model", model_info: { mode: "chat" } },
      { model_name: "k3-openai", model_info: { mode: "chat" } },
    ]);
    const ids = (models ?? []).map((m) => m.id);
    expect(ids).toEqual(["claude-sonnet-5"]);
  });

  it("过滤 embedding / rerank / image_generation 模式", () => {
    const models = transformModelInfo([
      { model_name: "text-embed-v1", model_info: { mode: "embedding" } },
      { model_name: "rerank-v1", model_info: { mode: "rerank" } },
      { model_name: "img-gen", model_info: { mode: "image_generation" } },
      { model_name: "claude-sonnet-5", model_info: { mode: "chat" } },
    ]);
    const ids = (models ?? []).map((m) => m.id);
    expect(ids).toEqual(["claude-sonnet-5"]);
  });

  it("mode 缺失不排除（自研/别名模型常态）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: {} },
    ]);
    expect((models ?? []).map((m) => m.id)).toEqual(["smart"]);
  });

  it("同名多 deployment 聚合：字段取首个非空值，vision 需全部 deployment 显式支持（all-true）", () => {
    const models = transformModelInfo([
      { model_name: "kimi-k2.7-code", model_info: { max_input_tokens: 200000, supports_vision: false } },
      { model_name: "kimi-k2.7-code", model_info: { max_output_tokens: 131072, supports_vision: true } },
    ]);
    const m = byId(models)["kimi-k2.7-code"];
    expect(m).toBeDefined();
    expect(m.contextWindow).toBe(200000);
    expect(m.maxTokens).toBe(131072);
    // false+true 混合 → 不宣传（LiteLLM 同名组轮询，宣传了任一 deployment 不支持
    // 的能力，轮到它时就 500）——C 项 any→all 修正
    expect(m.input).toEqual(["text"]);
  });

  it("未声明 supports_vision 按纯文本（input 仅 text）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: {} },
    ]);
    expect(byId(models)["smart"].input).toEqual(["text"]);
  });

  it("token 上限缺失时用默认值（cw 200000 / maxTok 64000）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: {} },
    ]);
    const m = byId(models)["smart"];
    expect(m.contextWindow).toBe(200000);
    expect(m.maxTokens).toBe(64000);
  });

  it("reasoning 按 REASONING_MODEL_PATTERN 名字前缀推断（claude-/kimi- 等）", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { mode: "chat" } },
      { model_name: "kimi-k2.7-code", model_info: {} },
      { model_name: "smart", model_info: {} },
    ]);
    const m = byId(models);
    expect(m["claude-sonnet-5"].reasoning).toBe(true);
    expect(m["kimi-k2.7-code"].reasoning).toBe(true);
    expect(m["smart"].reasoning).toBe(false);
  });

  it("cost 字段恒为 0（本地不读 /model/info 的 per-token 价；成本走 cost 跟踪头）", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { mode: "chat" } },
    ]);
    const m = byId(models)["claude-sonnet-5"];
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("空 data 或全被过滤时返回 null（触发上层回落 stored/fallback）", () => {
    expect(transformModelInfo([])).toBeNull();
    expect(transformModelInfo(undefined)).toBeNull();
    expect(
      transformModelInfo([
        { model_name: "staging/x", model_info: { mode: "chat" } },
        { model_name: "embed", model_info: { mode: "embedding" } },
      ]),
    ).toBeNull();
  });
});

/**
 * Cycle 2：读 model_info.supports_reasoning（研究 04 的 (a) 判决——47/53 部署有值，
 * 比名字正则更准）。网关显式声明优先于名字正则；缺失时回落正则（覆盖 6 个稀疏模型）。
 */
describe("transformModelInfo — supports_reasoning 字段", () => {
  it("supports_reasoning=true 覆盖名字正则（名字不匹配也判 true）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supports_reasoning: true } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(true);
  });

  it("supports_reasoning=false 覆盖名字正则（名字匹配也判 false）", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { supports_reasoning: false } },
    ]);
    expect(byId(models)["claude-sonnet-5"].reasoning).toBe(false);
  });

  it("supports_reasoning 缺失（null/未声明）回落名字正则", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { supports_reasoning: null } },
      { model_name: "smart", model_info: {} },
    ]);
    expect(byId(models)["claude-sonnet-5"].reasoning).toBe(true);
    expect(byId(models)["smart"].reasoning).toBe(false);
  });

  it("同名多 deployment：任一显式 supports_reasoning=false 即否决（一票否决）", () => {
    const models = transformModelInfo([
      { model_name: "kimi-k2.7-code", model_info: { supports_reasoning: false } },
      { model_name: "kimi-k2.7-code", model_info: { supports_reasoning: true } },
    ]);
    // false+true 混合 → false：不能宣传轮询组里某个后端没有的能力（C 项 any→all）
    expect(byId(models)["kimi-k2.7-code"].reasoning).toBe(false);
  });
});

/**
 * Cycle 3：supported_openai_params 奖励信号（研究 04 的 bonus——比名字正则更可靠）。
 * 当 supports_reasoning 缺失（稀疏模型）但网关在 supported_openai_params 里声明了
 * reasoning_effort / thinking 时，判 reasoning=true。优先级：supports_reasoning > params > 正则。
 */
describe("transformModelInfo — supported_openai_params 奖励", () => {
  it("supported_openai_params 含 reasoning_effort 且无 supports_reasoning → true（名字不匹配正则也判 true）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supported_openai_params: ["reasoning_effort", "tools"] } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(true);
  });

  it("supported_openai_params 含 thinking → true", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supported_openai_params: ["thinking", "temperature"] } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(true);
  });

  it("supported_openai_params 不含推理参数 → 回落正则（smart 不匹配 → false）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supported_openai_params: ["temperature", "tools"] } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(false);
  });

  it("supports_reasoning 显式 false 仍优先于 supported_openai_params 含 reasoning_effort", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supports_reasoning: false, supported_openai_params: ["reasoning_effort"] } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(false);
  });

  it("同名多 deployment：任一 supported_openai_params 含推理参数即判 true", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supported_openai_params: ["temperature"] } },
      { model_name: "smart", model_info: { supported_openai_params: ["reasoning_effort"] } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(true);
  });
});

/**
 * Cycle 4：推理模型声明 max 思考级别 + 走 anthropic adaptive thinking 腿。
 * thinkingLevelMap 只列 max（off/minimal/low/medium/high 在 pi 的
 * getSupportedThinkingLevels 里默认可选，xhigh 不声明——litellm 后端不支持）；
 * compat.forceAdaptiveThinking 让 effort 经 output_config.effort 传给网关
 * （否则 budget-based 把 max clamp 到 high，max 沦为 UI 摆设）。非推理模型不加。
 */
describe("transformModelInfo — max 思考级别 + adaptive thinking", () => {
  it("推理模型（supports_reasoning=true）声明 thinkingLevelMap.max 与 forceAdaptiveThinking", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { supports_reasoning: true } },
    ]);
    const m = byId(models)["claude-sonnet-5"];
    expect(m.thinkingLevelMap).toEqual({ max: "max" });
    expect(m.compat).toEqual({ forceAdaptiveThinking: true });
  });

  it("推理模型（名字正则匹配、supports_reasoning 缺失）同样声明", () => {
    const models = transformModelInfo([
      { model_name: "glm-5.2", model_info: {} },
    ]);
    const m = byId(models)["glm-5.2"];
    expect(m.thinkingLevelMap).toEqual({ max: "max" });
    expect(m.compat?.forceAdaptiveThinking).toBe(true);
  });

  it("推理模型（supported_openai_params 含 reasoning_effort）同样声明", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supported_openai_params: ["reasoning_effort"] } },
    ]);
    const m = byId(models)["smart"];
    expect(m.thinkingLevelMap).toEqual({ max: "max" });
    expect(m.compat?.forceAdaptiveThinking).toBe(true);
  });

  it("非推理模型（smart，无声明且名字不匹配）不含 thinkingLevelMap / compat", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: {} },
    ]);
    const m = byId(models)["smart"];
    expect(m.thinkingLevelMap).toBeUndefined();
    expect(m.compat).toBeUndefined();
  });

  it("supports_reasoning 显式 false（即使名字匹配正则）不含", () => {
    const models = transformModelInfo([
      { model_name: "claude-sonnet-5", model_info: { supports_reasoning: false } },
    ]);
    const m = byId(models)["claude-sonnet-5"];
    expect(m.reasoning).toBe(false);
    expect(m.thinkingLevelMap).toBeUndefined();
    expect(m.compat).toBeUndefined();
  });

  it("thinkingLevelMap 不含 xhigh（litellm 后端不支持）", () => {
    const models = transformModelInfo([
      { model_name: "glm-5.2", model_info: { supports_reasoning: true } },
    ]);
    const m = byId(models)["glm-5.2"];
    expect(m.thinkingLevelMap).not.toHaveProperty("xhigh");
  });
});

describe("fallbackModels", () => {
  it("所有 fallback 模型声明 max 思考级别 + forceAdaptiveThinking", () => {
    const models = fallbackModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.reasoning).toBe(true);
      expect(m.thinkingLevelMap).toEqual({ max: "max" });
      expect(m.compat?.forceAdaptiveThinking).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// C 项（balcsida v3.1.0 吸收）：多 deployment 能力聚合 any→all。
// LiteLLM 同名组轮询：vision / reasoning 声明层只在每个可路由 deployment 都解析为
// 支持时才宣传；显式 false 一票否决。reasoning 保留三态——"未声明混合/全未声明"
// 是不确定，回落模型级兜底（params / 名字正则），不否决。
// ---------------------------------------------------------------------------

describe("transformModelInfo — 多 deployment 能力聚合 any→all", () => {
  it("vision：全部 deployment 显式 true 才支持", () => {
    const allTrue = transformModelInfo([
      { model_name: "m1", model_info: { supports_vision: true } },
      { model_name: "m1", model_info: { supports_vision: true } },
    ]);
    expect(byId(allTrue)["m1"].input).toEqual(["text", "image"]);
  });

  it("vision：true + 未声明混合 → 不支持（未声明当不支持，发图会 500 的后端）", () => {
    const mixed = transformModelInfo([
      { model_name: "m2", model_info: { supports_vision: true } },
      { model_name: "m2", model_info: {} },
    ]);
    expect(byId(mixed)["m2"].input).toEqual(["text"]);
  });

  it("supports_reasoning：全部显式 true → true（名字不匹配正则也直出）", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { supports_reasoning: true } },
      { model_name: "smart", model_info: { supports_reasoning: true } },
    ]);
    expect(byId(models)["smart"].reasoning).toBe(true);
  });

  it("supports_reasoning：true + 未声明混合 → 不确定，回落名字级兜底（匹配正则则 true）", () => {
    const glm = transformModelInfo([
      { model_name: "glm-5.2", model_info: { supports_reasoning: true } },
      { model_name: "glm-5.2", model_info: {} },
    ]);
    expect(byId(glm)["glm-5.2"].reasoning).toBe(true);

    const smart = transformModelInfo([
      { model_name: "smart", model_info: { supports_reasoning: true } },
      { model_name: "smart", model_info: {} },
    ]);
    expect(byId(smart)["smart"].reasoning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v0.10.0 起：thinking 档位自动推导（网关元数据权威，ADR 0001）。
// 四级回落链：reasoning_effort_levels > per-level 布尔 > 现三级链。
// v0.10.1 起菜单精确对齐：有档位时 thinkingLevelMap 是网关档集的镜像——
// 档集内声明自身值（选什么发什么 effort），档集外的默认可选档以 null 显式
// 排除（pi 的 mapped===null 是通用菜单排除机制），edge 档（xhigh/max）档集
// 含才声明（pi 默认不可选），未知档名忽略；无档位（或同名组交集为空）维持
// 兜底 {max}。forceAdaptiveThinking 对所有 reasoning 模型保留（effort 传递
// 通道，budget 路径无法表达档位枚举）。
// ---------------------------------------------------------------------------

describe("transformModelInfo — reasoning_effort_levels 档位推导", () => {
  it("levels 存在即推理能力：reasoning=true 且 forceAdaptiveThinking 注入", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: { reasoning_effort_levels: ["low", "high", "max"] } },
    ]);
    const m = byId(models)["smart"];
    expect(m.reasoning).toBe(true);
    expect(m.compat?.forceAdaptiveThinking).toBe(true);
  });

  it("精确对齐：['low','high','max']（glm-5.3 形态）→ off/minimal/medium 以 null 排除，low/high/max 声明自身值", () => {
    const models = transformModelInfo([
      { model_name: "z-ai/glm-5.3", model_info: { reasoning_effort_levels: ["low", "high", "max"] } },
    ]);
    const map = byId(models)["z-ai/glm-5.3"].thinkingLevelMap;
    expect(map).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", max: "max" });
  });

  it("精确对齐：levels 含 xhigh → 一并声明（通用 edge 档处理，当前网关无此形态）", () => {
    const models = transformModelInfo([
      { model_name: "m", model_info: { reasoning_effort_levels: ["low", "high", "xhigh", "max"] } },
    ]);
    expect(byId(models)["m"].thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("精确对齐：levels 含 none（deepseek-flash 形态）→ off:\"off\" 可选（序列化器只查 off !== null 才发 disabled）", () => {
    const models = transformModelInfo([
      { model_name: "m", model_info: { reasoning_effort_levels: ["none", "low", "high", "max"] } },
    ]);
    expect(byId(models)["m"].thinkingLevelMap).toEqual({
      off: "off",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      max: "max",
    });
  });

  it("精确对齐：minimal 在档集 → 直传自身值（不走 pi 序列化 switch 的 minimal→low 近似）；档集不含 low 也不外溢", () => {
    const models = transformModelInfo([
      { model_name: "m", model_info: { reasoning_effort_levels: ["minimal", "high"] } },
    ]);
    expect(byId(models)["m"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: null,
      medium: null,
      high: "high",
    });
  });

  it("levels 无 edge 档（['low','medium','high']）→ 默认档照常对齐，map 不含 xhigh/max 键（pi 默认不可选，无需声明）", () => {
    const models = transformModelInfo([
      { model_name: "m", model_info: { reasoning_effort_levels: ["low", "medium", "high"] } },
    ]);
    expect(byId(models)["m"].thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: "medium", high: "high" });
    expect(byId(models)["m"].compat?.forceAdaptiveThinking).toBe(true);
  });

  it("未知档名忽略（LiteLLM 同款先例：丢弃而非报错）；过滤后全未知 → 视同未声明回落 {max} 兜底", () => {
    const mixed = transformModelInfo([
      { model_name: "m1", model_info: { reasoning_effort_levels: ["turbo", "low", "high"] } },
    ]);
    expect(byId(mixed)["m1"].thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high" });

    const allUnknown = transformModelInfo([
      { model_name: "glm-x", model_info: { reasoning_effort_levels: ["turbo", "ultra"] } },
    ]);
    expect(byId(allUnknown)["glm-x"].reasoning).toBe(true); // 名字正则兜底判推理
    expect(byId(allUnknown)["glm-x"].thinkingLevelMap).toEqual({ max: "max" });
  });

  it("levels 存在时无视 supports_reasoning 显式 false？不——显式 false 仍一票否决（回落链是能力判定，声明权威）", () => {
    const models = transformModelInfo([
      { model_name: "m", model_info: { supports_reasoning: false, reasoning_effort_levels: ["low", "high", "max"] } },
    ]);
    const m = byId(models)["m"];
    expect(m.reasoning).toBe(false);
    expect(m.thinkingLevelMap).toBeUndefined();
    expect(m.compat).toBeUndefined();
  });

  it("per-level 布尔（supports_*_reasoning_effort，LiteLLM 仅 none/minimal/low/xhigh/max 有布尔，medium/high 是默认档）拼装为档位集后照常对齐（levels 缺失时的第二级）", () => {
    const models = transformModelInfo([
      {
        model_name: "m",
        model_info: {
          supports_xhigh_reasoning_effort: true,
          supports_max_reasoning_effort: true,
        },
      },
    ]);
    expect(byId(models)["m"].thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("per-level 布尔全缺 → 落回现三级链（名字正则模型维持 hack 兜底 {max}）", () => {
    const models = transformModelInfo([
      { model_name: "glm-5.2", model_info: {} },
    ]);
    const m = byId(models)["glm-5.2"];
    expect(m.reasoning).toBe(true);
    expect(m.thinkingLevelMap).toEqual({ max: "max" });
    expect(m.compat?.forceAdaptiveThinking).toBe(true);
  });

  it("同名多 deployment levels 取交集（all-true 精神：只宣传轮询组全部支持的档位）", () => {
    const models = transformModelInfo([
      { model_name: "m", model_info: { reasoning_effort_levels: ["low", "high", "max"] } },
      { model_name: "m", model_info: { reasoning_effort_levels: ["low", "high"] } },
    ]);
    expect(byId(models)["m"].thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high" }); // 交集 ['low','high']，max 被交掉
  });

  it("同名组档位交集为空 → 视同未声明，回落 {max} 兜底（v0.10.1 修复：此前会产出 {off:null}，菜单只剩 off 连 max 都消失）", () => {
    const models = transformModelInfo([
      { model_name: "glm-x", model_info: { reasoning_effort_levels: ["low", "high"] } },
      { model_name: "glm-x", model_info: { reasoning_effort_levels: ["minimal", "medium"] } },
    ]);
    const m = byId(models)["glm-x"];
    expect(m.reasoning).toBe(true); // 名字正则兜底判推理
    expect(m.thinkingLevelMap).toEqual({ max: "max" });
  });

  it("非推理模型（无声明且名字不匹配）不受影响", () => {
    const models = transformModelInfo([
      { model_name: "smart", model_info: {} },
    ]);
    const m = byId(models)["smart"];
    expect(m.reasoning).toBe(false);
    expect(m.thinkingLevelMap).toBeUndefined();
    expect(m.compat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B 项（balcsida v3.1.0 吸收）：/model/info 成本字段填 model.cost。
// 请求前估算（模型选择 UI / 预算控制）此前恒为 0；与响应后口径的
// x-litellm-response-cost 实付跟踪互补。用例数据取自 2026-09-20 网关实测
// （moonshotai/kimi-k3、z-ai/glm-5.3 的真实落库值）。
// ---------------------------------------------------------------------------

describe("transformModelInfo — /model/info 成本字段", () => {
  it("读取 model_info 的 4 个 per-token 成本字段填入 cost", () => {
    const models = transformModelInfo([
      {
        model_name: "moonshotai/kimi-k3",
        model_info: {
          supports_reasoning: true,
          input_cost_per_token: 3e-6,
          output_cost_per_token: 1.5e-5,
          cache_read_input_token_cost: 1e-6,
          cache_creation_input_token_cost: 5e-7,
        },
      },
    ]);
    expect(byId(models)["moonshotai/kimi-k3"].cost).toEqual({ input: 3e-6, output: 1.5e-5, cacheRead: 1e-6, cacheWrite: 5e-7 });
  });

  it("成本字段缺失保持 0（防御默认：网关实测 z-ai/glm-5.3 缺 cacheWrite、kimi-k3 缺两个 cache 字段）", () => {
    const models = transformModelInfo([
      {
        model_name: "z-ai/glm-5.3",
        model_info: { input_cost_per_token: 1.4e-6, output_cost_per_token: 4.4e-6, cache_read_input_token_cost: 1.4e-6 },
      },
    ]);
    expect(byId(models)["z-ai/glm-5.3"].cost).toEqual({ input: 1.4e-6, output: 4.4e-6, cacheRead: 1.4e-6, cacheWrite: 0 });
  });

  it("同名多 deployment 成本按字段取 max（保守上界估算）", () => {
    const models = transformModelInfo([
      {
        model_name: "m",
        model_info: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      },
      {
        model_name: "m",
        model_info: { input_cost_per_token: 3e-6, output_cost_per_token: 1e-6 },
      },
    ]);
    expect(byId(models)["m"].cost).toEqual({ input: 3e-6, output: 2e-6, cacheRead: 0, cacheWrite: 0 });
  });
});

// ---------------------------------------------------------------------------
// stampCustomerHeader：模型级 customer 头注入（modifyModels 兜底通道）
// ---------------------------------------------------------------------------

describe("stampCustomerHeader", () => {
  const models = [
    { id: "glm-5.2", cost: { input: 0 } },
    { id: "kimi-k2.7-code", cost: { input: 0 }, headers: { "x-custom": "keep" } },
  ];

  it("JWT 命中 claim 时给每个模型注入 header，已有 headers 字段保留并合并", () => {
    const stamped = stampCustomerHeader(
      models,
      makeJwt({ email: "user@example.com" }),
      "x-litellm-customer-id",
      ["email"],
    );
    expect(stamped[0].headers).toEqual({ "x-litellm-customer-id": "user@example.com" });
    // 已有 header 不被清掉（spread 合并，注入键不冲突时共存）
    expect(stamped[1].headers).toEqual({
      "x-custom": "keep",
      "x-litellm-customer-id": "user@example.com",
    });
    // 原数组不被修改（纯函数）
    expect(models[0]).not.toHaveProperty("headers");
  });

  it("claim 链按顺序取第一个命中（email 缺失时回落 preferred_username）", () => {
    const stamped = stampCustomerHeader(
      [{ id: "glm-5.2" }],
      makeJwt({ preferred_username: "alice" }),
      "x-litellm-customer-id",
      ["email", "preferred_username"],
    );
    expect(stamped[0].headers?.["x-litellm-customer-id"]).toBe("alice");
  });

  it("非 JWT / claim 缺失 / 无 bearer / 未配置 header 时原样返回同一数组", () => {
    const a = stampCustomerHeader(models, opaqueToken(), "x-litellm-customer-id", ["email"]);
    const b = stampCustomerHeader(models, makeJwt({ sub: "x" }), "x-litellm-customer-id", ["email"]);
    const c = stampCustomerHeader(models, undefined, "x-litellm-customer-id", ["email"]);
    const d = stampCustomerHeader(models, makeJwt({ email: "a@b.c" }), "", ["email"]);
    expect(a).toBe(models);
    expect(b).toBe(models);
    expect(c).toBe(models);
    expect(d).toBe(models);
  });
});
