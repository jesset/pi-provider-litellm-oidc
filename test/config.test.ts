import { describe, expect, it } from "bun:test";
import { assertSecureUrl } from "../extension/config.ts";

/**
 * D 项（balcsida v3.1.0 吸收）：网关 / Keycloak URL 的 HTTPS 强制校验。
 * 误配 http:// 会明文发送 JWT access token 与 refresh token——在 config 模块加载
 * 时 fail-fast（防呆），唯一例外是 loopback（本地调试）。
 */
describe("assertSecureUrl", () => {
  it("https 通过", () => {
    expect(() => assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", "https://model.example.com")).not.toThrow();
    expect(() => assertSecureUrl("LITELLM_OIDC_KEYCLOAK_URL", "https://sso.example.com/realms/x")).not.toThrow();
  });

  it("http 非 loopback 抛错，错误信息含变量名与明文风险提示", () => {
    expect(() => assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", "http://model.example.com")).toThrow(/LITELLM_OIDC_GATEWAY_URL/);
    expect(() => assertSecureUrl("LITELLM_OIDC_KEYCLOAK_URL", "http://sso.example.com")).toThrow(/https/);
  });

  it("http loopback 例外（本地调试）：localhost / 127.x / [::1] 通过", () => {
    expect(() => assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", "http://localhost:4000")).not.toThrow();
    expect(() => assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", "http://127.0.0.1:4000")).not.toThrow();
    expect(() => assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", "http://[::1]:4000")).not.toThrow();
  });

  it("非 http(s) 协议抛错", () => {
    expect(() => assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", "ftp://model.example.com")).toThrow();
    expect(() => assertSecureUrl("LITELLM_OIDC_KEYCLOAK_URL", "not a url")).toThrow();
  });
});

describe("config 模块加载时校验（fail-fast）", () => {
  it("LITELLM_OIDC_GATEWAY_URL=http 非 loopback 时模块加载抛错", async () => {
    process.env.LITELLM_OIDC_GATEWAY_URL = "http://insecure.example.com";
    try {
      await expect(import(`../extension/config.ts?gate=http-${Date.now()}`)).rejects.toThrow(/LITELLM_OIDC_GATEWAY_URL/);
    } finally {
      delete process.env.LITELLM_OIDC_GATEWAY_URL;
    }
  });

  it("LITELLM_OIDC_KEYCLOAK_URL=http 非 loopback 时模块加载抛错", async () => {
    process.env.LITELLM_OIDC_KEYCLOAK_URL = "http://insecure.example.com";
    try {
      await expect(import(`../extension/config.ts?kc=http-${Date.now()}`)).rejects.toThrow(/LITELLM_OIDC_KEYCLOAK_URL/);
    } finally {
      delete process.env.LITELLM_OIDC_KEYCLOAK_URL;
    }
  });

  it("默认值（https 域名）加载不抛错", async () => {
    await expect(import(`../extension/config.ts?default-${Date.now()}`)).resolves.toBeDefined();
  });
});
