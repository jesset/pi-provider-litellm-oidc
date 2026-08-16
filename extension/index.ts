import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { config, customerConfig, sessionConfig } from "./config.ts";
import { extractJwtClaim, loginDeviceFlow, refreshAccessToken } from "./keycloak.ts";
import { fallbackModels, fetchGatewayModels } from "./models.ts";

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

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerProvider(config.providerId, {
    name: config.displayName,
    baseUrl: config.gatewayBaseUrl,
    api: "anthropic-messages",
    authHeader: true,
    models: fallbackModels(),
    oauth,
    async refreshModels(context): Promise<ProviderModelConfig[]> {
      // OAuth credentials are refreshed by the framework before reaching here.
      const credential = context.credential;
      const bearer = credential?.type === "oauth" ? credential.access : undefined;
      if (!bearer) return fallbackModels();
      return (await fetchGatewayModels(bearer)) ?? fallbackModels();
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
      // getApiKeyForProvider 返回框架管理的当前 access token（过期时框架先刷新，
      // 未登录返回 undefined，不会触发交互式登录）
      const bearer = await ctx.modelRegistry.getApiKeyForProvider(config.providerId);
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
