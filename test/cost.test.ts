import { describe, expect, it } from "bun:test";
import { parseResponseCost } from "../extension/cost.ts";

/** parseResponseCost：从响应头读成本（大小写不敏感），NaN/缺失返回 undefined。 */
describe("parseResponseCost", () => {
  it("读小写头名并解析科学计数法浮点", () => {
    expect(parseResponseCost({ "x-litellm-response-cost": "5.804e-05" })).toBeCloseTo(0.00005804, 10);
  });

  it("大小写不敏感匹配（网关/pi 均小写下发，此处容忍任意大小写）", () => {
    expect(parseResponseCost({ "X-Litellm-Response-Cost": "7.255e-05" })).toBeCloseTo(0.00007255, 10);
  });

  it("可配置头名：读 x-litellm-response-cost-original（折扣前）", () => {
    expect(parseResponseCost({ "x-litellm-response-cost-original": "0.001" }, "x-litellm-response-cost-original")).toBe(0.001);
  });

  it("头缺失返回 undefined", () => {
    expect(parseResponseCost({ "content-type": "application/json" })).toBeUndefined();
  });

  it("头值为 NaN 返回 undefined", () => {
    expect(parseResponseCost({ "x-litellm-response-cost": "not-a-number" })).toBeUndefined();
  });

  it("空头值返回 undefined", () => {
    expect(parseResponseCost({ "x-litellm-response-cost": "" })).toBeUndefined();
  });
});

import { attributeCost } from "../extension/cost.ts";

/** attributeCost：把单次请求总成本按 token 比例摊到 input/output/cacheRead/cacheWrite。 */
describe("attributeCost", () => {
  it("按 token 比例摊分（input/output）", () => {
    const c = attributeCost({ input: 10, output: 30 }, 0.4);
    expect(c.input).toBeCloseTo(0.1, 10);
    expect(c.output).toBeCloseTo(0.3, 10);
    expect(c.total).toBe(0.4);
  });

  it("含 cacheRead / cacheWrite 一起摊分", () => {
    const c = attributeCost({ input: 10, output: 10, cacheRead: 20, cacheWrite: 10 }, 1.0);
    expect(c.input).toBeCloseTo(0.2, 10);
    expect(c.output).toBeCloseTo(0.2, 10);
    expect(c.cacheRead).toBeCloseTo(0.4, 10);
    expect(c.cacheWrite).toBeCloseTo(0.2, 10);
    expect(c.total).toBe(1.0);
  });

  it("零 token 时各分项为 0，total 仍保留总成本", () => {
    const c = attributeCost({ input: 0, output: 0 }, 0.5);
    expect(c.input).toBe(0);
    expect(c.output).toBe(0);
    expect(c.cacheRead).toBe(0);
    expect(c.cacheWrite).toBe(0);
    expect(c.total).toBe(0.5);
  });

  it("cacheRead / cacheWrite 缺失按 0 处理", () => {
    const c = attributeCost({ input: 5, output: 5 }, 1.0);
    expect(c.cacheRead).toBe(0);
    expect(c.cacheWrite).toBe(0);
    expect(c.input).toBeCloseTo(0.5, 10);
    expect(c.output).toBeCloseTo(0.5, 10);
  });

  it("total 恒等于传入的 totalCost", () => {
    expect(attributeCost({ input: 100, output: 200 }, 5.804e-05).total).toBeCloseTo(5.804e-05, 12);
  });
});

import { setupLiteLLMCostTracking } from "../extension/cost.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 最小 fake pi：记录 .on 注册的 handler，emit 依次调用并返回最后结果。 */
function fakePi() {
  const handlers: Record<string, Array<(e: any, ctx: any) => any>> = {};
  const pi = {
    on(event: string, handler: any) {
      (handlers[event] ??= []).push(handler);
    },
  } as unknown as ExtensionAPI;
  const emit = async (event: string, e: any, ctx: any = {}) => {
    let result: any;
    for (const h of handlers[event] ?? []) result = await h(e, ctx);
    return result;
  };
  return { pi, emit };
}

const APR = (headers: Record<string, string>) => ({
  type: "after_provider_response" as const,
  status: 200,
  headers,
});
const CTX = (provider: string) => ({ model: { provider } });
const ME = (provider: string, usage: Record<string, number>) => ({
  type: "message_end" as const,
  message: { role: "assistant" as const, provider, usage },
});

/** setupLiteLLMCostTracking：两个 hook 的装配——provider 守卫、slot 存/清、串扰防护。 */
describe("setupLiteLLMCostTracking — hook 装配", () => {
  it("after_provider_response 存成本，message_end 按比例摊到 usage.cost", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm"]);
    await emit("after_provider_response", APR({ "x-litellm-response-cost": "0.4" }), CTX("litellm"));
    const result = await emit("message_end", ME("litellm", { input: 10, output: 30 }));
    expect(result.message.usage.cost.total).toBe(0.4);
    expect(result.message.usage.cost.input).toBeCloseTo(0.1, 10);
    expect(result.message.usage.cost.output).toBeCloseTo(0.3, 10);
    // 保留原有 usage 字段
    expect(result.message.usage.input).toBe(10);
  });

  it("摊分后清 slot：第二次 message_end 无成本返回 undefined", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm"]);
    await emit("after_provider_response", APR({ "x-litellm-response-cost": "0.4" }), CTX("litellm"));
    await emit("message_end", ME("litellm", { input: 10, output: 30 }));
    const result2 = await emit("message_end", ME("litellm", { input: 5, output: 5 }));
    expect(result2).toBeUndefined();
  });

  it("非已知 provider 的响应被忽略（不污染 LiteLLM 成本状态）", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm"]);
    await emit("after_provider_response", APR({ "x-litellm-response-cost": "0.4" }), CTX("openai"));
    const result = await emit("message_end", ME("openai", { input: 10, output: 30 }));
    expect(result).toBeUndefined();
  });

  it("无成本头的响应清掉 slot（防止跨请求残留串扰）", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm"]);
    await emit("after_provider_response", APR({ "x-litellm-response-cost": "0.4" }), CTX("litellm"));
    // 同 provider 的无头响应清 slot
    await emit("after_provider_response", APR({}), CTX("litellm"));
    const result = await emit("message_end", ME("litellm", { input: 10, output: 30 }));
    expect(result).toBeUndefined();
  });

  it("无 pending 成本时 message_end 不摊分（返回 undefined）", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm"]);
    const result = await emit("message_end", ME("litellm", { input: 10, output: 30 }));
    expect(result).toBeUndefined();
  });

  it("按 provider 隔离 slot：B 的无头响应不清 A 的 pending（串扰防护）", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm", "litellm2"]);
    await emit("after_provider_response", APR({ "x-litellm-response-cost": "0.4" }), CTX("litellm"));
    await emit("after_provider_response", APR({}), CTX("litellm2"));
    const result = await emit("message_end", ME("litellm", { input: 10, output: 30 }));
    expect(result.message.usage.cost.total).toBe(0.4);
  });

  it("可配置头名：读 x-litellm-response-cost-original", async () => {
    const { pi, emit } = fakePi();
    setupLiteLLMCostTracking(pi, ["litellm"], "x-litellm-response-cost-original");
    await emit("after_provider_response", APR({ "x-litellm-response-cost-original": "0.001" }), CTX("litellm"));
    const result = await emit("message_end", ME("litellm", { input: 50, output: 50 }));
    expect(result.message.usage.cost.total).toBe(0.001);
  });
});
