import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { config, sessionConfig } from "./config.ts";
import { loginDeviceFlow, refreshAccessToken } from "./keycloak.ts";
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

  // 为发往本 provider 网关的请求注入稳定 session 标识，便于网关侧把同一会话的
  // 多次请求（工具调用循环、重试、多 turn）聚合到同一 session。
  // 只作用于本 provider 的请求（按 ctx.model.provider 过滤），不影响其他 provider。
  // 重试复用相同 headers，hook 不会重复触发，session id 保持一致。
  pi.on("before_provider_headers", (event, ctx) => {
    if (!sessionConfig.header) return; // 显式禁用
    if (ctx.model?.provider !== config.providerId) return; // 仅本 provider 的请求

    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return; // 无会话则跳过

    event.headers[sessionConfig.header] = `${sessionConfig.prefix}${sessionId}`;

    if (sessionConfig.clientHeader) {
      event.headers[sessionConfig.clientHeader] = "pi";
    }
  });

  // /session-header — 查看当前注入配置，便于排查网关聚合问题
  pi.registerCommand("session-header", {
    description: "查看 session 标识注入配置与当前 session id",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "（无）";
      const lines = [
        `session id : ${sessionId}`,
        sessionConfig.header
          ? `注入 header : ${sessionConfig.header}: ${sessionConfig.prefix}${sessionId}（仅 ${config.providerId} 的请求）`
          : "注入 header : 已禁用（LITELLM_SESSION_HEADER 为空）",
        `client 头  : ${sessionConfig.clientHeader ? `${sessionConfig.clientHeader}: pi` : "未启用"}`,
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
