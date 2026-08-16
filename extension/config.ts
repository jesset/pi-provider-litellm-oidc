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

/**
 * Session 标识注入（网关侧会话聚合）。
 * 默认 "x-litellm-trace-id"：LiteLLM proxy 原生解析链中优先级最高的会话/追踪头，
 * 值会写入 LiteLLM_SpendLogs.session_id 列并同步 trace_id/session_id metadata，
 * Session Logs UI 按它分组；旧的 "x-session-id" 不匹配 LiteLLM 的
 * `^x-.+-session-id$` 通用正则（缺 vendor 段），会被网关完全忽略。
 * LITELLM_SESSION_HEADER 显式设为空字符串可禁用注入
 * （不能用 env()：它对空值回退 fallback，会吞掉“显式禁用”语义）。
 */
const sessionHeaderRaw = process.env.LITELLM_SESSION_HEADER;

export const sessionConfig = {
  /** 注入的 header 名；空字符串表示禁用 */
  header: sessionHeaderRaw === undefined ? "x-litellm-trace-id" : sessionHeaderRaw.trim(),
  /** 可选前缀，例如 "pi-"。注意：LiteLLM 校验值为 ^[a-zA-Z0-9_-]{8,}$，
   *  前缀含 . / : 等字符会使整个 header 被网关丢弃，建议只用字母数字与 - _ */
  prefix: env("LITELLM_SESSION_PREFIX", ""),
  /** 可选的第二个 header 名（值固定 "pi"），用于网关侧客户端归因；默认不发送 */
  clientHeader: env("LITELLM_SESSION_CLIENT_HEADER", ""),
};

/**
 * Customer（终端用户）标识注入（网关侧按用户维度归因 spend）。
 * 默认 "x-litellm-customer-id"：LiteLLM proxy 的标准 customer/end-user 头，网关零配置
 * 即解析（Always checked without any configuration），值写入 SpendLogs 的 customer 维度；
 * 配合网关侧 user_header_mappings / extra_spend_tag_headers 可按用户 email 建用户、打 spend tag。
 * 值取自 Keycloak 签发的 access token（JWT）的 claim（默认 email，可用逗号分隔配置回退链）。
 * LITELLM_CUSTOMER_HEADER 显式设为空字符串可禁用注入（语义同 LITELLM_SESSION_HEADER）。
 */
const customerHeaderRaw = process.env.LITELLM_CUSTOMER_HEADER;

export const customerConfig = {
  /** 注入的 header 名；空字符串表示禁用 */
  header: customerHeaderRaw === undefined ? "x-litellm-customer-id" : customerHeaderRaw.trim(),
  /** 依次尝试的 JWT claim 名，默认 ["email"]；可配 "email,preferred_username" 等回退链 */
  claims: env("LITELLM_CUSTOMER_CLAIM", "email")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
};

export const keycloak = {
  deviceEndpoint: `${config.keycloakBaseUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/auth/device`,
  tokenEndpoint: `${config.keycloakBaseUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/token`,
};

export const modelsEndpoint = `${config.gatewayBaseUrl}/v1/models`;
