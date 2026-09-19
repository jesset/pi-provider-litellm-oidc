import { describe, expect, it } from "bun:test";
import { generateCodeVerifier, pkceChallenge } from "../extension/keycloak.ts";

/**
 * PKCE（v0.9.1 起）：Keycloak 26 对 public client 的 device grant 默认强制 PKCE
 * （client 属性 pkceCodeChallengeMethod=S256），扩展在 device 授权请求带 S256
 * challenge、token 轮询带 verifier。挑战派生用 RFC 7636 Appendix B 官方测试向量
 * 锁定实现正确性。
 */
describe("pkceChallenge (RFC 7636 §4.2, S256)", () => {
  it("RFC 7636 Appendix B 官方测试向量", () => {
    // verifier -> challenge（附录 B "Plain S256" 示例）
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("不同 verifier 产生不同 challenge（对 verifier 敏感）", () => {
    expect(pkceChallenge("a")).not.toBe(pkceChallenge("b"));
  });
});

describe("generateCodeVerifier (RFC 7636 §4.1)", () => {
  it("43 字符且仅含 unreserved 字符集（32 字节 base64url）", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    }
  });

  it("每次调用产生独立 verifier（高熵）", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(50);
  });
});
