import { describe, expect, it } from "bun:test";
import { extractJwtClaim } from "../extension/keycloak.ts";
import { makeJwt, opaqueToken } from "./helpers.ts";

/**
 * extractJwtClaim：从 access token（JWT）的 payload 镜像 claim，供 customer 头归因。
 * 不验签（同 token 本就作为 bearer 发往网关）。锁定现有行为——改认证代码前先建安全网。
 */
describe("extractJwtClaim", () => {
  it("返回第一个命中的非空字符串 claim", () => {
    const token = makeJwt({ email: "user@example.com" });
    expect(extractJwtClaim(token, ["email"])).toBe("user@example.com");
  });

  it("claim 回退链：前一个缺失时取后一个", () => {
    const token = makeJwt({ preferred_username: "alice" });
    expect(extractJwtClaim(token, ["email", "preferred_username"])).toBe("alice");
  });

  it("回退链跳过空字符串 claim，继续找下一个非空", () => {
    const token = makeJwt({ email: "", preferred_username: "bob" });
    expect(extractJwtClaim(token, ["email", "preferred_username"])).toBe("bob");
  });

  it("所有 claim 都缺失时返回 undefined", () => {
    const token = makeJwt({ sub: "123" });
    expect(extractJwtClaim(token, ["email", "preferred_username"])).toBeUndefined();
  });

  it("claim 值为非字符串（数字/布尔）时跳过", () => {
    const token = makeJwt({ email: 12345, verified: true });
    expect(extractJwtClaim(token, ["email", "verified"])).toBeUndefined();
  });

  it("非 JWT（opaque token，无 payload 段）返回 undefined", () => {
    expect(extractJwtClaim(opaqueToken(), ["email"])).toBeUndefined();
  });

  it("payload 非法 JSON 时静默返回 undefined（不抛）", () => {
    const header = Buffer.from('{"alg":"none"}', "utf8").toString("base64url");
    const badPayload = Buffer.from("not-json{", "utf8").toString("base64url");
    expect(extractJwtClaim(`${header}.${badPayload}.sig`, ["email"])).toBeUndefined();
  });
});
