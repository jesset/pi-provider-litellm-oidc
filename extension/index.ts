import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { config } from "./config.ts";
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
}
