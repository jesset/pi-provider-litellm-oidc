import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsStoreEntry, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { config, customerConfig, sessionConfig } from "./config.ts";
import { extractJwtClaim, loginDeviceFlow, refreshAccessToken } from "./keycloak.ts";
import { fallbackModels, fetchGatewayModels, storedModels } from "./models.ts";

const oauth: NonNullable<ProviderConfig["oauth"]> = {
  name: `${config.displayName} (Keycloak SSO)`,

  async login(callbacks: OAuthLoginCallbacks) {
    return loginDeviceFlow(callbacks);
  },

  async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
    return refreshAccessToken(credentials.refresh, signal);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};

/** 大小写不敏感地取请求头中的 Bearer token；无 authorization 头或空值时返回 undefined。 */
function bearerToken(headers: Record<string, string | null>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" && value) {
      const token = value.trim().replace(/^Bearer\s+/i, "");
      return token || undefined;
    }
  }
  return undefined;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerProvider(config.providerId, {
    name: config.displayName,
    baseUrl: config.gatewayBaseUrl,
    api: "anthropic-messages",
    authHeader: true,
    models: fallbackModels(),
    oauth,
    async refreshModels(context): Promise<ProviderModelConfig[]> {
      // 框架两阶段刷新协议：allowNetwork=false 是离线缓存恢复阶段（扩展注册、
      // 每次 refresh 的 phase 1），契约禁止网络访问——只回落持久化目录或静态列表。
      if (!context.allowNetwork) {
        return storedModels(context.stored) ?? fallbackModels();
      }
      // OAuth credentials are refreshed by the framework before reaching here.
      const credential = context.credential;
      const bearer = credential?.type === "oauth" ? credential.access : undefined;
      if (!bearer) return fallbackModels();
      const fetched = await fetchGatewayModels(bearer, context.signal);
      if (fetched) {
        // 持久化目录（models-store.json），供下次离线阶段恢复真实模型列表；
        // publish 由框架按 generation 检查后落盘，中止时安全丢弃
        const entry = { models: fetched, checkedAt: Date.now() } as unknown as ModelsStoreEntry;
        await context.publish({ persist: entry });
        return fetched;
      }
      return storedModels(context.stored) ?? fallbackModels();
    },
  });

  // 为发往本 provider 网关的请求注入：
  //  1. 稳定 session 标识——把同一会话的多次请求（工具调用循环、重试、多 turn）
  //     聚合到同一 session（写入 LiteLLM SpendLogs.session_id）；
  //  2. customer 标识（默认 x-litellm-customer-id）——从当前 access token（JWT）
  //     解出用户 email，供网关按用户维度建 customer / 打 spend tag。
  // 只作用于本 provider 的请求（按 ctx.model.provider 过滤），不影响其他 provider。
  // 重试复用相同 headers，hook 不会重复触发，session id 保持一致。
  pi.on("before_provider_headers", async (event, ctx) => {
    if (ctx.model?.provider !== config.providerId) return; // 仅本 provider 的请求

    if (sessionConfig.header) {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (sessionId) {
        event.headers[sessionConfig.header] = `${sessionConfig.prefix}${sessionId}`;

        if (sessionConfig.clientHeader) {
          event.headers[sessionConfig.clientHeader] = "pi";
        }
      }
    }

    if (customerConfig.header) {
      // authHeader: true 时框架（provider-composer 的 withConfiguredAuth）已把
      // Authorization: Bearer <access> 写入最终请求头；直接从 event.headers 取
      // token 解 claim——与实际发送的 token 严格同源，且免去每请求一次冗余的
      // getApiKeyForProvider 全量 auth 解析（含 auth.json stat 与锁路径）。
      // 未登录时无此 header，自然跳过；非 JWT / claim 缺失时静默不注入。
      const bearer = bearerToken(event.headers);
      const customerId = bearer ? extractJwtClaim(bearer, customerConfig.claims) : undefined;
      if (customerId) {
        event.headers[customerConfig.header] = customerId;
      }
    }
  });

  // /session-header — 查看当前注入配置，便于排查网关聚合/归因问题
  pi.registerCommand("session-header", {
    description: "查看 session / customer 标识注入配置与当前 session id",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "（无）";
      let customerLine: string;
      if (!customerConfig.header) {
        customerLine = "customer 头: 已禁用（LITELLM_CUSTOMER_HEADER 为空）";
      } else {
        const bearer = await ctx.modelRegistry.getApiKeyForProvider(config.providerId);
        const customerId = bearer ? extractJwtClaim(bearer, customerConfig.claims) : undefined;
        customerLine = `customer 头: ${customerConfig.header}: ${
          customerId ?? `（无法解析：${bearer ? `token 无 ${customerConfig.claims.join("/")} claim` : "未登录"}）`
        }（仅 ${config.providerId} 的请求）`;
      }
      const lines = [
        `session id : ${sessionId}`,
        sessionConfig.header
          ? `注入 header : ${sessionConfig.header}: ${sessionConfig.prefix}${sessionId}（仅 ${config.providerId} 的请求）`
          : "注入 header : 已禁用（LITELLM_SESSION_HEADER 为空）",
        `client 头  : ${sessionConfig.clientHeader ? `${sessionConfig.clientHeader}: pi` : "未启用"}`,
        customerLine,
      ];

      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        // print / json 模式下直接打到 stderr，不污染管道输出
        console.error(`[${config.providerId} session-header]\n${lines.map((l) => `  ${l}`).join("\n")}`);
      }
    },
  });
}
