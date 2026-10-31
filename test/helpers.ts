import type { InstanceConfig } from "../extension/config.ts";

/**
 * 测试公用工具：构造可控的 JWT / opaque token，避免依赖真实 Keycloak。
 * 这些只用于测试，不进 esbuild bundle（entry 仅 extension/index.ts）。
 */

/** base64url 编码（无 padding），与 JWT 段编码一致。 */
export function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/** 构造一个 JWT（header.payload.signature），payload 为任意对象。 */
export function makeJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = "sig";
  return `${header}.${body}.${sig}`;
}

/** 构造一个非 JWT 的 opaque token（无点分段 / 非法 payload）。 */
export function opaqueToken(): string {
  return "opaque-token-without-dots";
}

export function testInstance(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    providerId: "litellm-oidc",
    displayName: "LiteLLM OIDC gateway",
    gatewayBaseUrl: "https://litellm.example.com",
    keycloakBaseUrl: "https://keycloak.example.com",
    keycloakRealm: "example",
    keycloakClientId: "coding-agent-cli",
    keycloakScope: "openid profile email offline_access",
    modelInfoPath: "/model/info",
    customer: { header: "x-litellm-customer-id", claims: ["email"] },
    fallbackModels: [],
    ...overrides,
  };
}
