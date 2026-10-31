/**
 * LiteLLM 成本 / 用量可观测性。
 *
 * 机制：after_provider_response 把网关返回的 x-litellm-response-cost（单次请求总成本）
 * 存入按 provider 隔离的 pending slot；message_end 把它按 input/output/cache token
 * 比例摊到 message.usage.cost，供 pi/omp 的每轮成本展示。
 *
 * leg 无关（pi-ai 已把 anthropic *_tokens 归一为统一 Usage）；pi + omp 均有这两个 hook，
 * 不用 before_provider_headers（omp 缺，但成本跟踪不需要它）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 从响应头读成本（大小写不敏感匹配，容忍任意大小写下发）。
 * NaN / 缺失 / 空值返回 undefined（调用方据此清 slot，防止跨 provider 串扰）。
 */
export function parseResponseCost(
  headers: Record<string, string>,
  headerName = "x-litellm-response-cost",
): number | undefined {
  const target = headerName.toLowerCase();
  let raw: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      raw = value;
      break;
    }
  }
  if (!raw) return undefined;
  const cost = Number.parseFloat(String(raw));
  return Number.isNaN(cost) ? undefined : cost;
}

/** 成本分项（与 pi-ai Usage.cost 形状一致）。 */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** message_end 摊分用的 token 用量子集（cache 字段可缺）。 */
interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 把单次请求总成本按 input/output/cacheRead/cacheWrite token 比例摊分。
 * 零 token 时各分项为 0，total 仍保留总成本（单次请求成本不丢）。
 * fraction = tokens / totalTokens（totalTokens>0 否则 0）。
 */
export function attributeCost(usage: TokenUsage, totalCost: number): CostBreakdown {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens = usage.input + usage.output + cacheRead + cacheWrite;
  const fraction = (tokens: number): number => (totalTokens > 0 ? tokens / totalTokens : 0);
  return {
    input: totalCost * fraction(usage.input),
    output: totalCost * fraction(usage.output),
    cacheRead: totalCost * fraction(cacheRead),
    cacheWrite: totalCost * fraction(cacheWrite),
    total: totalCost,
  };
}

/**
 * 注册两个 hook 实现 LiteLLM 成本跟踪。
 *
 * - after_provider_response：把网关 x-litellm-response-cost（单次请求总成本）存入按
 *   provider 隔离的 pending slot；无成本头的响应清掉该 provider 的 slot（防残留串扰）。
 * - message_end：取 pending 总成本，按 token 比例摊到 message.usage.cost，清 slot，
 *   返回 { message } 替换最终消息（pi/omp 均支持该返回形状）。
 *
 * 按 provider 隔离 slot：多 provider 交错请求时，一个 provider 的无头响应不会清掉
 * 另一个的 pending 成本（跨请求串扰防护）。
 * leg 无关（pi-ai 已把 anthropic *_tokens 归一为统一 Usage）；pi + omp 均有这两个 hook。
 */
export function setupLiteLLMCostTracking(
  pi: ExtensionAPI,
  providerNames: string[],
  headerName = "x-litellm-response-cost",
): void {
  const knownProviders = new Set(providerNames);
  const pendingResponseCosts = new Map<string, number>();

  pi.on("after_provider_response", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (!provider || !knownProviders.has(provider)) return;
    const cost = parseResponseCost(event.headers ?? {}, headerName);
    if (cost !== undefined) {
      pendingResponseCosts.set(provider, cost);
    } else {
      pendingResponseCosts.delete(provider);
    }
  });

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant" || !knownProviders.has(message.provider)) return;
    const usage = message.usage;
    if (!usage) return;

    const totalCost = pendingResponseCosts.get(message.provider);
    if (totalCost === undefined) return;
    pendingResponseCosts.delete(message.provider);

    return {
      message: {
        ...message,
        usage: {
          ...usage,
          cost: attributeCost(usage, totalCost),
        },
      },
    };
  });
}
