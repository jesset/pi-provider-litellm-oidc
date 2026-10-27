import { describe, expect, it, spyOn } from "bun:test";
import { resolve } from "node:path";
import { assertSecureUrl, loadRuntimeConfig, parseConfigFile } from "../extension/config.ts";

const HOME = "/home/test";
const NODE = "/usr/local/bin/node";
const PI_DEFAULT = "/home/test/.pi/agent/litellm-oidc.json";

function reader(files: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    read(path: string): string {
      calls.push(path);
      if (!(path in files)) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files[path];
    },
  };
}

function instance(id = "litellm") {
  return {
    id,
    name: `${id} Gateway`,
    gatewayUrl: `https://${id}.example.com`,
    keycloakUrl: `https://sso.${id}.example.com`,
    realm: "Realm",
    clientId: "coding-agent-cli",
  };
}

function document() {
  return { instances: [instance("litellm"), instance("staging")] };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("assertSecureUrl", () => {
  it("https 通过", () => {
    expect(() => assertSecureUrl("gateway", "https://model.example.com")).not.toThrow();
    expect(() => assertSecureUrl("keycloak", "https://sso.example.com/realms/x")).not.toThrow();
  });

  it("http 非 loopback 抛错，错误信息含字段名", () => {
    expect(() => assertSecureUrl("gateway", "http://model.example.com")).toThrow(/gateway/);
    expect(() => assertSecureUrl("keycloak", "http://sso.example.com")).toThrow(/https/);
  });

  it("http loopback 例外", () => {
    expect(() => assertSecureUrl("gateway", "http://localhost:4000")).not.toThrow();
    expect(() => assertSecureUrl("gateway", "http://127.0.0.1:4000")).not.toThrow();
    expect(() => assertSecureUrl("gateway", "http://[::1]:4000")).not.toThrow();
  });

  it("非 http(s) 协议或非法 URL 抛错", () => {
    expect(() => assertSecureUrl("gateway", "ftp://model.example.com")).toThrow();
    expect(() => assertSecureUrl("keycloak", "not a url")).toThrow();
  });
});

describe("legacy env 单实例", () => {
  it("无配置文件时保持 LiteLLM 默认值与内置 fallback 语义", () => {
    const files = reader({});
    const config = loadRuntimeConfig({}, files.read, NODE, HOME);
    expect(config.source).toBe("legacy-env");
    expect(config.instances).toHaveLength(1);
    expect(config.instances[0]).toMatchObject({
      providerId: "litellm",
      displayName: "LiteLLM Gateway",
      gatewayBaseUrl: "https://litellm.example.com",
      keycloakBaseUrl: "https://keycloak.example.com",
      keycloakRealm: "Example",
      keycloakClientId: "coding-agent-cli",
      modelInfoPath: "/model/info",
    });
    expect(config.instances[0].fallbackModels).toBeUndefined();
    expect(config.session.header).toBe("x-litellm-trace-id");
    expect(config.customer.claims).toEqual(["email"]);
    expect(config.cost).toEqual({ enabled: true, header: "x-litellm-response-cost" });
    expect(files.calls).toEqual([PI_DEFAULT]);
  });

  it("读取现有 LITELLM_OIDC_* 与全局空字符串语义", () => {
    const config = loadRuntimeConfig({
      LITELLM_OIDC_PROVIDER_ID: "custom",
      LITELLM_OIDC_DISPLAY_NAME: "Custom Gateway",
      LITELLM_OIDC_GATEWAY_URL: "https://gateway.example.com",
      LITELLM_OIDC_KEYCLOAK_URL: "https://sso.example.com",
      LITELLM_OIDC_KEYCLOAK_REALM: "custom-realm",
      LITELLM_OIDC_KEYCLOAK_CLIENT_ID: "custom-client",
      LITELLM_OIDC_KEYCLOAK_SCOPE: "openid offline_access",
      LITELLM_SESSION_HEADER: "",
      LITELLM_CUSTOMER_HEADER: "",
      LITELLM_CUSTOMER_CLAIM: "email, preferred_username",
      LITELLM_COST_TRACKING: "",
      LITELLM_COST_HEADER: "",
    }, reader({}).read, NODE, HOME);
    expect(config.instances[0]).toMatchObject({
      providerId: "custom",
      displayName: "Custom Gateway",
      gatewayBaseUrl: "https://gateway.example.com",
      keycloakBaseUrl: "https://sso.example.com",
      keycloakRealm: "custom-realm",
      keycloakClientId: "custom-client",
      keycloakScope: "openid offline_access",
    });
    expect(config.session.header).toBe("");
    expect(config.customer.header).toBe("");
    expect(config.customer.claims).toEqual(["email", "preferred_username"]);
    expect(config.cost.enabled).toBe(false);
    expect(config.cost.header).toBe("x-litellm-response-cost");
  });

  it("legacy URL 仍在加载时强制 HTTPS", () => {
    expect(() => loadRuntimeConfig({ LITELLM_OIDC_GATEWAY_URL: "http://insecure.example.com" }, reader({}).read, NODE, HOME))
      .toThrow(/LITELLM_OIDC_GATEWAY_URL/);
  });
});

describe("配置文件发现", () => {
  it("显式 LITELLM_OIDC_CONFIG 优先并完全取代 env 实例配置", () => {
    const files = reader({ "/config/instances.json": json(document()) });
    const config = loadRuntimeConfig({
      LITELLM_OIDC_CONFIG: "/config/instances.json",
      LITELLM_OIDC_PROVIDER_ID: "ignored",
      PI_CODING_AGENT_DIR: "/agent",
    }, files.read, NODE, HOME);
    expect(config.source).toBe("file:/config/instances.json");
    expect(config.instances.map((entry) => entry.providerId)).toEqual(["litellm", "staging"]);
    expect(files.calls).toEqual(["/config/instances.json"]);
  });

  it("相对显式路径按当前工作目录解析", () => {
    const path = resolve("fixtures/instances.json");
    const files = reader({ [path]: json(document()) });
    const config = loadRuntimeConfig({ LITELLM_OIDC_CONFIG: "fixtures/instances.json" }, files.read, NODE, HOME);
    expect(config.source).toBe(`file:${path}`);
  });

  it("无显式路径时读取 PI_CODING_AGENT_DIR", () => {
    const path = "/agent/litellm-oidc.json";
    const files = reader({ [path]: json(document()) });
    const config = loadRuntimeConfig({ PI_CODING_AGENT_DIR: "/agent" }, files.read, NODE, HOME);
    expect(config.source).toBe(`file:${path}`);
  });

  it("pi 默认路径为 ~/.pi/agent/litellm-oidc.json", () => {
    const files = reader({ [PI_DEFAULT]: json(document()) });
    const config = loadRuntimeConfig({}, files.read, NODE, HOME);
    expect(config.source).toBe(`file:${PI_DEFAULT}`);
  });

  it("omp 按 PI_CONFIG_DIR 与 profile 推导默认路径", () => {
    const path = "/omp/profiles/work/agent/litellm-oidc.json";
    const files = reader({ [path]: json(document()) });
    const config = loadRuntimeConfig({ PI_CONFIG_DIR: "/omp", OMP_PROFILE: "work" }, files.read, "/usr/local/bin/omp", HOME);
    expect(config.source).toBe(`file:${path}`);
  });

  it("omp 的 default profile 按运行时语义使用根 agent 目录", () => {
    const path = "/home/test/.omp/agent/litellm-oidc.json";
    const files = reader({ [path]: json(document()) });
    const config = loadRuntimeConfig({ OMP_PROFILE: "default" }, files.read, "/usr/local/bin/omp", HOME);
    expect(config.source).toBe(`file:${path}`);
  });

  it("未知运行时按 pi → omp 顺序探测", () => {
    const warning = spyOn(console, "error").mockImplementation(() => {});
    try {
      const path = "/home/test/.omp/agent/litellm-oidc.json";
      const files = reader({ [path]: json(document()) });
      const config = loadRuntimeConfig({}, files.read, "/usr/local/bin/custom-runtime", HOME);
      expect(config.source).toBe(`file:${path}`);
      expect(files.calls).toEqual([PI_DEFAULT, path]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("显式路径缺失直接失败，不回落 legacy env", () => {
    expect(() => loadRuntimeConfig({
      LITELLM_OIDC_CONFIG: "/missing.json",
      LITELLM_OIDC_PROVIDER_ID: "legacy",
    }, reader({}).read, NODE, HOME)).toThrow(/配置文件不可读/);
  });

  it("自动发现的非法 JSON 直接失败", () => {
    const files = reader({ [PI_DEFAULT]: "not-json" });
    expect(() => loadRuntimeConfig({}, files.read, NODE, HOME)).toThrow(/JSON 解析失败/);
  });
});

describe("文件 schema 与归一化", () => {
  it("解析多个实例，默认 scope/modelInfoPath，fallback 缺省为空", () => {
    const config = parseConfigFile(document(), "file:test", {});
    expect(config.instances).toHaveLength(2);
    for (const entry of config.instances) {
      expect(entry.keycloakScope).toBe("openid profile email offline_access");
      expect(entry.modelInfoPath).toBe("/model/info");
      expect(entry.fallbackModels).toEqual([]);
      expect(entry.customer.header).toBe("x-litellm-customer-id");
    }
  });

  it("文件顶层覆盖全局 env，实例 customer 再覆盖全局", () => {
    const config = parseConfigFile({
      instances: [{ ...instance("staging"), customer: { claims: ["preferred_username"] } }],
      session: { header: "", prefix: "pi-" },
      customer: { claims: ["sub"] },
      cost: { enabled: false, header: "x-cost" },
    }, "file:test", {
      LITELLM_SESSION_PREFIX: "env-",
      LITELLM_SESSION_CLIENT_HEADER: "x-client",
      LITELLM_CUSTOMER_HEADER: "x-env-customer",
      LITELLM_COST_TRACKING: "1",
    });
    expect(config.session).toEqual({ header: "", prefix: "pi-", clientHeader: "x-client" });
    expect(config.customer).toEqual({ header: "x-env-customer", claims: ["sub"] });
    expect(config.instances[0].customer).toEqual({ header: "x-env-customer", claims: ["preferred_username"] });
    expect(config.cost).toEqual({ enabled: false, header: "x-cost" });
  });

  it("fallbackModels 完整透传 ProviderModelConfig", () => {
    const model = {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 64000,
      thinkingLevelMap: { off: null, max: "max" },
      compat: { forceAdaptiveThinking: true },
      headers: { "x-static": "yes" },
    };
    const config = parseConfigFile({ instances: [{ ...instance(), fallbackModels: [model] }] }, "file:test", {});
    expect(config.instances[0].fallbackModels).toEqual([model]);
  });

  it("compat 拒绝未知字段与非布尔标志，开放 Record 自定义键保持透传", () => {
    const model = {
      id: "x", name: "x", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
    };
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, compat: { forceAdaptiveThinking: true, typo: true } }] }],
    }, "file:test", {})).toThrow(/compat 含未知字段: typo/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, compat: { forceAdaptiveThinking: "yes" } }] }],
    }, "file:test", {})).toThrow(/forceAdaptiveThinking 必须是布尔值/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, compat: { chatTemplateKwargs: { $custom: "thinking.enabled" } } }] }],
    }, "file:test", {})).not.toThrow();
  });

  it("文件 cost.header 必须非空，禁用成本使用 enabled", () => {
    expect(() => parseConfigFile({ ...document(), cost: { header: "" } }, "file:test", {})).toThrow(/cost.header 不能为空/);
    expect(parseConfigFile({ ...document(), cost: { enabled: false } }, "file:test", {}).cost.enabled).toBe(false);
  });

  it("instances 必须是非空数组", () => {
    expect(() => parseConfigFile({ instances: [] }, "file:test", {})).toThrow(/非空数组/);
    expect(() => parseConfigFile({}, "file:test", {})).toThrow(/非空数组/);
  });

  it("根、实例、全局块与 fallback 的未知字段均失败", () => {
    expect(() => parseConfigFile({ ...document(), typo: true }, "file:test", {})).toThrow(/未知字段: typo/);
    expect(() => parseConfigFile({ instances: [{ ...instance(), gatewayURL: "https://x" }] }, "file:test", {}))
      .toThrow(/未知字段: gatewayURL/);
    expect(() => parseConfigFile({ ...document(), session: { heder: "x" } }, "file:test", {})).toThrow(/未知字段: heder/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ id: "x", typo: true }] }],
    }, "file:test", {})).toThrow(/未知字段: typo/);
  });

  it("缺少实例必填字段时指出字段路径", () => {
    const entry = instance() as Record<string, unknown>;
    delete entry.clientId;
    expect(() => parseConfigFile({ instances: [entry] }, "file:test", {})).toThrow(/instances\[0\]\.clientId/);
  });

  it("拒绝重复、非法及内置 provider id", () => {
    expect(() => parseConfigFile({ instances: [instance("same"), instance("same")] }, "file:test", {}))
      .toThrow(/重复/);
    expect(() => parseConfigFile({ instances: [instance("Bad/Id")] }, "file:test", {})).toThrow(/必须匹配/);
    expect(() => parseConfigFile({ instances: [instance("anthropic")] }, "file:test", {})).toThrow(/内置 provider/);
    expect(() => parseConfigFile({ instances: [instance("radius")] }, "file:test", {})).toThrow(/内置 provider/);
  });

  it("文件实例 URL 强制 HTTPS，loopback 例外", () => {
    expect(() => parseConfigFile({ instances: [{ ...instance(), gatewayUrl: "http://gateway.example.com" }] }, "file:test", {}))
      .toThrow(/https/);
    expect(() => parseConfigFile({ instances: [{ ...instance(), gatewayUrl: "http://localhost:4000" }] }, "file:test", {}))
      .not.toThrow();
  });

  it("modelInfoPath 必须以 / 开头", () => {
    expect(() => parseConfigFile({ instances: [{ ...instance(), modelInfoPath: "model/info" }] }, "file:test", {}))
      .toThrow(/modelInfoPath/);
  });

  it("fallback 模型校验必填字段、input 与非负成本", () => {
    const valid = {
      id: "x", name: "x", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
    };
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...valid, input: ["audio"] }] }],
    }, "file:test", {})).toThrow(/input\[0\]/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...valid, cost: { ...valid.cost, input: -1 } }] }],
    }, "file:test", {})).toThrow(/非负有限数字/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...valid, contextWindow: 0 }] }],
    }, "file:test", {})).toThrow(/必须大于 0/);
  });
});
