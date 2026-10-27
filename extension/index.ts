import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsStoreEntry, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { loadRuntimeConfig } from "./config.ts";
import type { InstanceConfig, RuntimeConfig } from "./config.ts";
import { setupLiteLLMCostTracking } from "./cost.ts";
import { extractJwtClaim, loginDeviceFlow, refreshAccessToken } from "./keycloak.ts";
import { fallbackModels, fetchGatewayModels, stampCustomerHeader, storedModels } from "./models.ts";

function createOAuth(instance: InstanceConfig): NonNullable<ProviderConfig["oauth"]> {
  return {
    name: `${instance.displayName} (Keycloak SSO)`,
    async login(callbacks: OAuthLoginCallbacks) {
      return loginDeviceFlow(instance, callbacks);
    },
    async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
      return refreshAccessToken(instance, credentials, signal);
    },
    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
    modifyModels(models, credentials) {
      return stampCustomerHeader(models, credentials?.access, instance.customer.header, instance.customer.claims);
    },
  };
}

function createProviderConfig(instance: InstanceConfig): ProviderConfig {
  return {
    name: instance.displayName,
    baseUrl: instance.gatewayBaseUrl,
    api: "anthropic-messages",
    authHeader: true,
    models: fallbackModels(instance),
    oauth: createOAuth(instance),
    async refreshModels(context): Promise<ProviderModelConfig[]> {
      if (!context.allowNetwork) {
        return storedModels(context.stored) ?? fallbackModels(instance);
      }
      const credential = context.credential;
      const bearer = credential?.type === "oauth" ? credential.access : undefined;
      if (!bearer) return fallbackModels(instance);
      const fetched = await fetchGatewayModels(instance, bearer, context.signal);
      if (fetched) {
        const entry = { models: fetched, checkedAt: Date.now() } as unknown as ModelsStoreEntry;
        await context.publish({ persist: entry });
        return fetched;
      }
      return storedModels(context.stored) ?? fallbackModels(instance);
    },
  };
}

function bearerToken(headers: Record<string, string | null>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" && value) {
      const token = value.trim().replace(/^Bearer\s+/i, "");
      return token || undefined;
    }
  }
  return undefined;
}

export function setupExtension(pi: ExtensionAPI, config: RuntimeConfig): void {
  for (const instance of config.instances) {
    pi.registerProvider(instance.providerId, createProviderConfig(instance));
  }
  const byProvider = new Map(config.instances.map((instance) => [instance.providerId, instance]));

  pi.on("before_provider_headers", async (event, ctx) => {
    const instance = byProvider.get(ctx.model?.provider ?? "");
    if (!instance) return;

    if (config.session.header) {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (sessionId) {
        event.headers[config.session.header] = `${config.session.prefix}${sessionId}`;
        if (config.session.clientHeader) {
          event.headers[config.session.clientHeader] = "pi";
        }
      }
    }

    if (instance.customer.header) {
      const bearer = bearerToken(event.headers);
      const customerId = bearer ? extractJwtClaim(bearer, instance.customer.claims) : undefined;
      if (customerId) {
        event.headers[instance.customer.header] = customerId;
      }
    }
  });

  if (config.cost.enabled) {
    setupLiteLLMCostTracking(pi, config.instances.map((instance) => instance.providerId), config.cost.header);
  }

  pi.registerCommand("session-header", {
    description: "查看各 LiteLLM OIDC 实例的 session / customer 注入与登录状态",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "（无）";
      const lines = [
        `配置来源 : ${config.source}`,
        `session id : ${sessionId}`,
        config.session.header
          ? `session 头 : ${config.session.header}: ${config.session.prefix}${sessionId}（全部实例）`
          : "session 头 : 已禁用（header 为空）",
        `client 头  : ${config.session.clientHeader ? `${config.session.clientHeader}: pi` : "未启用"}`,
      ];

      for (const instance of config.instances) {
        lines.push("", `[${instance.providerId}] ${instance.displayName}`);
        const bearer = await ctx.modelRegistry.getApiKeyForProvider(instance.providerId);
        lines.push(`登录状态 : ${bearer ? "已登录" : "未登录"}`);
        if (!instance.customer.header) {
          lines.push("customer 头: 已禁用（header 为空）");
          continue;
        }
        const customerId = bearer ? extractJwtClaim(bearer, instance.customer.claims) : undefined;
        lines.push(
          `customer 头: ${instance.customer.header}: ${
            customerId ?? `（无法解析：${bearer ? `token 无 ${instance.customer.claims.join("/")} claim` : "未登录"}）`
          }`,
        );
      }

      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        console.error(`[litellm-oidc session-header]\n${lines.map((line) => `  ${line}`).join("\n")}`);
      }
    },
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  setupExtension(pi, loadRuntimeConfig(process.env));
}
