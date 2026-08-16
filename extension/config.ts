/**
 * 可通过环境变量完全覆盖的部署配置。
 * 未设置任何变量时保持 LiteLLM 默认值，开箱即用；设置 LEGACY_PROVIDER_ID 即可
 * 以独立 provider 身份接入另一套 Keycloak + LiteLLM 网关（多实例并存）。
 */

export const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export const config = {
  /** Pi provider ID，也是 /login、--model 的前缀 */
  providerId: env("LEGACY_PROVIDER_ID", "litellm"),
  displayName: env("LEGACY_DISPLAY_NAME", "LiteLLM Gateway"),

  gatewayBaseUrl: env("LEGACY_GATEWAY_URL", "https://litellm.example.com"),

  keycloakBaseUrl: env("LEGACY_KEYCLOAK_URL", "https://keycloak.example.com"),
  keycloakRealm: env("LEGACY_KEYCLOAK_REALM", "Example"),
  keycloakClientId: env("LEGACY_KEYCLOAK_CLIENT_ID", "coding-agent-cli"),
  /** Keycloak OIDC scope；必须含 offline_access 才能拿到长时 refresh token */
  keycloakScope: env("LEGACY_KEYCLOAK_SCOPE", "openid profile email offline_access"),
};

export const keycloak = {
  deviceEndpoint: `${config.keycloakBaseUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/auth/device`,
  tokenEndpoint: `${config.keycloakBaseUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/token`,
};

export const modelsEndpoint = `${config.gatewayBaseUrl}/v1/models`;
