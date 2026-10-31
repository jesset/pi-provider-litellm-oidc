import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { trimTrailingSlash } from "./config.ts";
import type { InstanceConfig } from "./config.ts";

/** 新 AuthInteraction 通道的 device_code 通知事件；legacy 通道无 notify 字段 */
interface DeviceCodeNotifyEvent {
  type: "device_code";
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

/**
 * 扩展 login 回调的运行时形状。pi 与 omp 当前都传 legacy OAuthLoginCallbacks
 * （pi 完整、omp 缺 onDeviceCode）；未来框架若把扩展通道切到 AuthInteraction，
 * 对象上会出现 notify/prompt——字段按可选探测，见 loginDeviceFlow 内三级展示。
 */
type LoginCallbacks = OAuthLoginCallbacks & {
  notify?: (event: DeviceCodeNotifyEvent) => void;
};

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

/**
 * Keycloak 按 RFC 8628 对 authorization_pending / slow_down / access_denied /
 * expired_token 等一律返回 4xx + JSON error body。postForm 把可解析的 error body
 * 附在 OAuthHttpError 上抛出，由调用方按 OAuth 语义分类（如设备流轮询）；
 * 只有 fetch / JSON 解析层的异常才被调用方当作 transient 容错重试。
 */
class OAuthHttpError extends Error {
  readonly payload: TokenResponse;

  constructor(url: string, status: number, payload: TokenResponse) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${status}`;
    super(`Keycloak ${url.split("/").pop()}: ${detail}`);
    this.name = "OAuthHttpError";
    this.payload = payload;
  }
}

async function postForm(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok) throw new OAuthHttpError(url, response.status, payload);
  return payload;
}

/**
 * RFC 7636 PKCE：Keycloak 26 起 admin console 对 public client 默认将 PKCE method
 * 设为 S256（client 属性 `pkceCodeChallengeMethod`，Capability config 的 "PKCE method"），
 * device 授权端点对 PKCE-enforced client 校验 code_challenge/code_challenge_method
 * （DeviceEndpoint.handleDeviceRequest → AuthorizationEndpointChecker.checkPKCEParams），
 * 缺参报 "Missing parameter: code_challenge_method"。OAuth 2.1 对 public client 全
 * grant 强制 PKCE，属正确安全基线，不应在服务端关闭——扩展自 0.9.1 起实现 PKCE：
 * device 授权请求带 code_challenge（S256），token 轮询带 code_verifier。旧版
 * Keycloak 忽略这些参数，向后兼容（LiteLLM 当前部署同样可用）。
 */

/** RFC 7636 §4.2 S256：challenge = BASE64URL(SHA256(ASCII(verifier)))。 */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** RFC 7636 §4.1：verifier 用高熵随机生成，43 字符（32 字节 base64url）。 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function keycloakEndpoints(instance: InstanceConfig): { device: string; token: string } {
  const realmBase = `${trimTrailingSlash(instance.keycloakBaseUrl)}/realms/${instance.keycloakRealm}/protocol/openid-connect`;
  return { device: `${realmBase}/auth/device`, token: `${realmBase}/token` };
}

/** RFC 8628 Device Authorization Flow against Keycloak. */
export async function loginDeviceFlow(instance: InstanceConfig, callbacks: LoginCallbacks): Promise<OAuthCredentials> {
  const signal = callbacks.signal;
  const endpoints = keycloakEndpoints(instance);

  // PKCE（见上文）：每个 device flow 会话独立 verifier，challenge 随授权请求发出，
  // verifier 在 token 轮询时兑现——窃取 device_code 无法单独兑换 token
  const codeVerifier = generateCodeVerifier();

  const deviceRes = await fetch(endpoints.device, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: instance.keycloakClientId,
      scope: instance.keycloakScope,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: "S256",
    }).toString(),
    signal,
  });
  const device = (await deviceRes.json()) as DeviceAuthorizationResponse;
  if (!deviceRes.ok || !device.device_code || !device.user_code) {
    const detail = (device as { error_description?: string; error?: string }).error_description
      ?? (device as { error?: string }).error
      ?? `HTTP ${deviceRes.status}`;
    throw new Error(`Keycloak device authorization failed: ${detail}`);
  }

  // 设备码展示按运行时传入的回调能力三级探测：
  // 1) onDeviceCode —— pi（adaptOAuth 适配器）构造的 legacy 回调完整提供，
  //    走原生设备码对话框；
  // 2) onAuth —— omp（compiled binary）的 legacy 回调省略了 onDeviceCode，
  //    回退到 onAuth：verificationUri 作可点击 URL、userCode 写入 instructions，
  //    omp 的 LoginDialog 渲染等价登录对话框（实测 omp 18.0.0）；
  // 3) notify({type:"device_code"}) —— 新 AuthInteraction 通道（pi-ai 内置
  //    provider 已用此形状；扩展通道未来若切换，此处自动生效，无需发版）。
  const verificationUri = device.verification_uri_complete ?? device.verification_uri;
  if (typeof callbacks.onDeviceCode === "function") {
    callbacks.onDeviceCode({
      userCode: device.user_code,
      verificationUri,
      intervalSeconds: device.interval ?? 5,
      expiresInSeconds: device.expires_in ?? 600,
    });
  } else if (typeof callbacks.onAuth === "function") {
    callbacks.onAuth({
      url: verificationUri,
      instructions: `Enter code ${device.user_code} at the URL above to verify`,
    });
  } else if (typeof callbacks.notify === "function") {
    callbacks.notify({
      type: "device_code",
      userCode: device.user_code,
      verificationUri,
      intervalSeconds: device.interval ?? 5,
      expiresInSeconds: device.expires_in ?? 600,
    });
  }

  let intervalMs = (device.interval ?? 5) * 1000;
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs, undefined, { signal });
    signal?.throwIfAborted();

    const poll = await postForm(
      endpoints.token,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: instance.keycloakClientId,
        device_code: device.device_code,
        code_verifier: codeVerifier,
      },
      signal,
    ).catch((err: unknown) => {
      if ((err as Error).name === "AbortError") throw err;
      // HTTP 层错误（含 slow_down / access_denied / expired_token 等 OAuth error）
      // 原样交给下方分类逻辑，避免 fail-slow（如用户拒绝授权后空转到超时）；
      // 仅网络 / 非 JSON 响应等传输层异常按 pending 容错，下轮重试
      if (err instanceof OAuthHttpError) return err.payload;
      return { access_token: "", expires_in: 0, error: "authorization_pending" } as TokenResponse;
    });

    if (poll.access_token) {
      return toCredentials(poll);
    }
    if (poll.error === "authorization_pending") continue;
    if (poll.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`Keycloak device flow ended: ${poll.error_description ?? poll.error}`);
  }

  throw new Error("Device code expired before verification completed. Run /login again.");
}

/**
 * refresh 瞬态失败 backoff。Keycloak 瞬断 / 限流时，
 * pi credential lock 后排队的刷新调用会形成惊群（每次都再打一次 token
 * endpoint）——5s 窗口内直接返回未过期的旧 credentials 避免惊群。按 refresh
 * token keyed（一个凭证的失败不拖累另一个）；仅 transient（postForm 的 fetch /
 * JSON 解析层异常）记录，OAuth 语义错误（OAuthHttpError，如 invalid_grant）照抛
 * 强制重登；旧 token 已过期时也不 backoff（返回过期凭证无意义，宁可立刻重试）。
 */
const TRANSIENT_REFRESH_BACKOFF_MS = 5_000;
/** refreshToken → backoff 截止时刻（epoch ms） */
const transientRefreshBackoffUntil = new Map<string, number>();

/** RFC 6749 refresh_token grant. Keycloak rotates refresh tokens; the new one must be persisted. */
export async function refreshAccessToken(instance: InstanceConfig, credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
  signal.throwIfAborted();
  const backoffKey = `${instance.providerId}\0${credentials.refresh}`;
  const holdUntil = transientRefreshBackoffUntil.get(backoffKey);
  if (holdUntil !== undefined && Date.now() < holdUntil && Date.now() < credentials.expires) {
    return credentials;
  }
  const endpoints = keycloakEndpoints(instance);
  try {
    const tokens = await postForm(
      endpoints.token,
      {
        grant_type: "refresh_token",
        client_id: instance.keycloakClientId,
        refresh_token: credentials.refresh,
        scope: instance.keycloakScope,
      },
      signal,
    );
    transientRefreshBackoffUntil.delete(backoffKey);
    return toCredentials(tokens);
  } catch (err) {
    if (!(err instanceof OAuthHttpError) && Date.now() < credentials.expires) {
      transientRefreshBackoffUntil.set(backoffKey, Date.now() + TRANSIENT_REFRESH_BACKOFF_MS);
    }
    throw err;
  }
}

/**
 * 从 JWT 中提取第一个命中的非空字符串 claim（不验签）。
 * token 直接来自我们配置的 Keycloak（TLS 通道），且同一 token 本就作为 bearer
 * 发往网关——这里只是把它的 payload claim 镜像成 header，供网关归因，无伪造面。
 * 非 JWT / claim 缺失时返回 undefined。
 */
export function extractJwtClaim(token: string, claims: string[]): string | undefined {
  const payloadSeg = token.split(".")[1];
  if (!payloadSeg) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(payloadSeg, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const claim of claims) {
      const value = payload[claim];
      if (typeof value === "string" && value) return value;
    }
  } catch {
    // 非 JWT（opaque token）等场景：静默跳过，不注入
  }
  return undefined;
}

function toCredentials(tokens: TokenResponse): OAuthCredentials {
  if (!tokens.refresh_token) {
    // Keycloak only issues refresh tokens when offline_access scope is granted.
    throw new Error("Keycloak response missing refresh_token — check that the client scope offline_access is enabled");
  }
  return {
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + tokens.expires_in * 1000,
  };
}
