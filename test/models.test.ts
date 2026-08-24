import { describe, expect, it } from "bun:test";
import { stampCustomerHeader, transformModelInfo } from "../extension/models.ts";
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

  it("同名多 deployment 聚合：字段取首个非空值，vision 任一声明即支持", () => {
    const models = transformModelInfo([
      { model_name: "kimi-k2.7-code", model_info: { max_input_tokens: 200000, supports_vision: false } },
      { model_name: "kimi-k2.7-code", model_info: { max_output_tokens: 131072, supports_vision: true } },
    ]);
    const m = byId(models)["kimi-k2.7-code"];
    expect(m).toBeDefined();
    expect(m.contextWindow).toBe(200000);
    expect(m.maxTokens).toBe(131072);
    expect(m.input).toEqual(["text", "image"]);
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

  it("同名多 deployment：任一声明 supports_reasoning=true 即判 true", () => {
    const models = transformModelInfo([
      { model_name: "kimi-k2.7-code", model_info: { supports_reasoning: false } },
      { model_name: "kimi-k2.7-code", model_info: { supports_reasoning: true } },
    ]);
    expect(byId(models)["kimi-k2.7-code"].reasoning).toBe(true);
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
