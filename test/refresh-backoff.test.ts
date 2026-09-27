import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { refreshAccessToken } from "../extension/keycloak.ts";

/**
 * A 项（balcsida v3.1.0 吸收）：refresh 瞬态失败 backoff。
 * Keycloak 瞬断/限流时，pi credential lock 后排队的刷新调用会形成惊群（每次都
 * 再请求一次 token endpoint）；5s backoff 窗口内直接返回未过期的旧 credentials。
 * 按 refresh token keyed（一个凭证的失败不拖累另一个）；仅 transient（fetch /
 * JSON 解析层异常）记录，OAuth 语义错误（invalid_grant 等 4xx）照抛强制重登。
 *
 * backoff 状态是模块级 Map：每个用例用独立的 refresh token，避免窗口跨用例泄漏。
 */

const T0 = Date.parse("2026-09-20T10:00:00Z");
const signal = new AbortController().signal;

/** 未过期的旧凭证（expires 在 T0 之后 expiresInMs） */
function creds(refresh: string, expiresInMs = 60_000) {
  return { access: "old-access", refresh, expires: T0 + expiresInMs };
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let respond: () => Promise<Response>;

const transient = () => Promise.reject(new TypeError("fetch failed"));
const oauthError = () =>
  Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token is not active" }), { status: 400 }));
const success = () =>
  Promise.resolve(new Response(JSON.stringify({ access_token: "new-access", refresh_token: "rt-rotated", expires_in: 300 }), { status: 200 }));

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

describe("refreshAccessToken — transient backoff", () => {
  it("transient 失败后 5s 窗口内：返回旧 credentials，不打网络", async () => {
    setSystemTime(T0);
    respond = transient;

    await expect(refreshAccessToken(creds("rt-c1"), signal)).rejects.toThrow("fetch failed");
    expect(fetchCalls).toBe(1);

    // 窗口内（T0+1s）第二次调用：不发请求，原样返回未过期的旧凭证
    setSystemTime(T0 + 1_000);
    await expect(refreshAccessToken(creds("rt-c1"), signal)).resolves.toEqual(creds("rt-c1"));
    expect(fetchCalls).toBe(1);
  });

  it("窗口过后恢复重试；成功后清除 backoff 记录（下一次失败可立即再试）", async () => {
    setSystemTime(T0);
    respond = transient;
    await expect(refreshAccessToken(creds("rt-c2"), signal)).rejects.toThrow("fetch failed");

    // 窗口结束（T0+5001ms）重试成功
    setSystemTime(T0 + 5_001);
    respond = success;
    await expect(refreshAccessToken(creds("rt-c2"), signal)).resolves.toMatchObject({ access: "new-access", refresh: "rt-rotated" });
    expect(fetchCalls).toBe(2);

    // 成功已清记录：紧接着的新一轮失败会立即打网络（而非沿用旧窗口）
    respond = transient;
    await expect(
      refreshAccessToken({ access: "new-access", refresh: "rt-rotated", expires: T0 + 6_000 }, signal),
    ).rejects.toThrow("fetch failed");
    expect(fetchCalls).toBe(3);
  });

  it("OAuth 语义错误（4xx invalid_grant）不记 backoff：下次调用立即重试", async () => {
    setSystemTime(T0);
    respond = oauthError;
    await expect(refreshAccessToken(creds("rt-c3"), signal)).rejects.toThrow(/invalid_grant|Token is not active/);
    expect(fetchCalls).toBe(1);

    // 无 backoff 窗口：紧接的第二次调用直接打网络
    respond = success;
    await expect(refreshAccessToken(creds("rt-c3"), signal)).resolves.toMatchObject({ access: "new-access" });
    expect(fetchCalls).toBe(2);
  });

  it("旧 token 已过期时的 transient 失败不 backoff（返回过期凭证无意义，立即重试）", async () => {
    setSystemTime(T0);
    respond = transient;
    const expired = { access: "old-access", refresh: "rt-c4", expires: T0 - 1_000 };
    await expect(refreshAccessToken(expired, signal)).rejects.toThrow("fetch failed");
    await expect(refreshAccessToken(expired, signal)).rejects.toThrow("fetch failed");
    expect(fetchCalls).toBe(2);
  });

  it("backoff 按 refresh token 隔离：rt-a 的失败不拖累 rt-b", async () => {
    setSystemTime(T0);
    respond = transient;
    await expect(refreshAccessToken(creds("rt-a"), signal)).rejects.toThrow("fetch failed");

    respond = success;
    await expect(refreshAccessToken(creds("rt-b"), signal)).resolves.toMatchObject({ access: "new-access" });
    expect(fetchCalls).toBe(2);
  });

  it("backoff 窗口内旧 token 恰好过期：不再返回旧凭证（宁可重试）", async () => {
    setSystemTime(T0);
    respond = transient;
    await expect(refreshAccessToken(creds("rt-c6", 2_000), signal)).rejects.toThrow("fetch failed");

    // 窗口未过（T0+3s < T0+5s）但凭证已过期（expires=T0+2s）：应打网络而非返回过期凭证
    setSystemTime(T0 + 3_000);
    respond = success;
    await expect(refreshAccessToken(creds("rt-c6", -1_000), signal)).resolves.toMatchObject({ access: "new-access" });
    expect(fetchCalls).toBe(2);
  });
});
