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

function instance(id = "litellm-oidc") {
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
  return { instances: [instance("litellm-oidc"), instance("staging")] };
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
    expect(() => assertSecureUrl("gateway", "http://127.255.255.254:4000")).not.toThrow();
    expect(() => assertSecureUrl("gateway", "http://[::1]:4000")).not.toThrow();
  });

  it("127 开头的域名不是 loopback（startsWith 误放行修复）", () => {
    expect(() => assertSecureUrl("gateway", "http://127.evil.example.com")).toThrow(/https/);
    expect(() => assertSecureUrl("gateway", "http://127.0.0.1.evil.example.com")).toThrow(/https/);
  });

  it("非 http(s) 协议或非法 URL 抛错", () => {
    expect(() => assertSecureUrl("gateway", "ftp://model.example.com")).toThrow();
    expect(() => assertSecureUrl("keycloak", "not a url")).toThrow();
  });
});

describe("legacy env 单实例", () => {
  it("无配置文件且未设置环境变量时 fail-fast，不提供部署默认值", () => {
    const files = reader({});
    expect(() => loadRuntimeConfig({}, files.read, NODE, HOME)).toThrow(/required environment variables are missing: LITELLM_OIDC_PROVIDER_ID, LITELLM_OIDC_GATEWAY_URL/);
    expect(files.calls).toEqual([PI_DEFAULT]);
  });

  it("环境变量齐全时定义单实例，displayName 缺省回退 providerId", () => {
    const files = reader({});
    const config = loadRuntimeConfig({
      LITELLM_OIDC_PROVIDER_ID: "litellm-oidc",
      LITELLM_OIDC_GATEWAY_URL: "https://litellm.example.com",
      LITELLM_OIDC_KEYCLOAK_URL: "https://keycloak.example.com",
      LITELLM_OIDC_KEYCLOAK_REALM: "example",
      LITELLM_OIDC_KEYCLOAK_CLIENT_ID: "coding-agent-cli",
    }, files.read, NODE, HOME);
    expect(config.source).toBe("legacy-env");
    expect(config.instances).toHaveLength(1);
    expect(config.instances[0]).toMatchObject({
      providerId: "litellm-oidc",
      displayName: "litellm-oidc",
      gatewayBaseUrl: "https://litellm.example.com",
      keycloakBaseUrl: "https://keycloak.example.com",
      keycloakRealm: "example",
      keycloakClientId: "coding-agent-cli",
      modelInfoPath: "/model/info",
    });
    // 内置静态目录已移除：legacy 实例的兜底目录恒为空，离线时以 /model/info 为准
    expect(config.instances[0].fallbackModels).toEqual([]);
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
    expect(() => loadRuntimeConfig({
      LITELLM_OIDC_PROVIDER_ID: "litellm-oidc",
      LITELLM_OIDC_GATEWAY_URL: "http://insecure.example.com",
      LITELLM_OIDC_KEYCLOAK_URL: "https://keycloak.example.com",
      LITELLM_OIDC_KEYCLOAK_REALM: "example",
      LITELLM_OIDC_KEYCLOAK_CLIENT_ID: "coding-agent-cli",
    }, reader({}).read, NODE, HOME))
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
    expect(config.instances.map((entry) => entry.providerId)).toEqual(["litellm-oidc", "staging"]);
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

  it("bun 宿主（omp 以 env bun 脚本分发）按 pi → omp 顺序探测", () => {
    const warning = spyOn(console, "error").mockImplementation(() => {});
    try {
      const path = "/home/test/.omp/agent/litellm-oidc.json";
      const files = reader({ [path]: json(document()) });
      const config = loadRuntimeConfig({}, files.read, "/Users/test/.bun/bin/bun", HOME);
      expect(config.source).toBe(`file:${path}`);
      expect(files.calls).toEqual([PI_DEFAULT, path]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
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
    }, reader({}).read, NODE, HOME)).toThrow(/config file referenced by LITELLM_OIDC_CONFIG is not readable/);
  });

  it("自动发现的非法 JSON 直接失败", () => {
    const files = reader({ [PI_DEFAULT]: "not-json" });
    expect(() => loadRuntimeConfig({}, files.read, NODE, HOME)).toThrow(/failed to parse config file JSON/);
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

  it("imageClassifiers：string[] 名单透传，非数组/非字符串元素失败（decisions 图像能力的配置兑底通道）", () => {
    const ok = parseConfigFile(
      { instances: [{ ...instance(), imageClassifiers: ["typesafe/jev-latest", "my-jev"] }] },
      "file:test",
      {},
    );
    expect(ok.instances[0].imageClassifiers).toEqual(["typesafe/jev-latest", "my-jev"]);
    // 缺省 undefined（不宣传）
    expect(parseConfigFile({ instances: [instance()] }, "file:test", {}).instances[0].imageClassifiers).toBeUndefined();
    expect(() =>
      parseConfigFile({ instances: [{ ...instance(), imageClassifiers: "typesafe/jev-latest" }] }, "file:test", {}),
    ).toThrow();
    expect(() =>
      parseConfigFile({ instances: [{ ...instance(), imageClassifiers: [42] }] }, "file:test", {}),
    ).toThrow();
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

  it("compat 透传：框架 schema 归 pi-ai 所有，未知字段与嵌套结构放行，仅拒绝非 JSON 值", () => {
    const model = {
      id: "x", name: "x", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
    };
    // 未来框架版本的合法字段（本机两套运行时字段集已不同）必须能通过
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, compat: { supportsMidConvoEffort: true, allowedFallbackModels: ["a"] } }] }],
    }, "file:test", {})).not.toThrow();
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, compat: { openRouterRouting: { order: ["x"], max_price: { prompt: 1 } } } }] }],
    }, "file:test", {})).not.toThrow();
    // 非 JSON 值（直接调用 parseConfigFile 可传入函数）拒绝
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, compat: { forceAdaptiveThinking: (() => {}) as unknown as boolean } }] }],
    }, "file:test", {})).toThrow(/must be a JSON value/);
  });

  it("fallbackModels[].baseUrl 同受 HTTPS 强制", () => {
    const model = {
      id: "x", name: "x", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
    };
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, baseUrl: "http://insecure.example.com" }] }],
    }, "file:test", {})).toThrow(/baseUrl/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...model, baseUrl: "http://localhost:4000" }] }],
    }, "file:test", {})).not.toThrow();
  });

  it("文件 cost.header 必须非空，禁用成本使用 enabled", () => {
    expect(() => parseConfigFile({ ...document(), cost: { header: "" } }, "file:test", {})).toThrow(/cost.header must not be empty/);
    expect(parseConfigFile({ ...document(), cost: { enabled: false } }, "file:test", {}).cost.enabled).toBe(false);
  });

  it("instances 必须是非空数组", () => {
    expect(() => parseConfigFile({ instances: [] }, "file:test", {})).toThrow(/non-empty array/);
    expect(() => parseConfigFile({}, "file:test", {})).toThrow(/non-empty array/);
  });

  it("根、实例、全局块与 fallback 的未知字段均失败", () => {
    expect(() => parseConfigFile({ ...document(), typo: true }, "file:test", {})).toThrow(/unknown field: typo/);
    expect(() => parseConfigFile({ instances: [{ ...instance(), gatewayURL: "https://x" }] }, "file:test", {}))
      .toThrow(/unknown field: gatewayURL/);
    expect(() => parseConfigFile({ ...document(), session: { heder: "x" } }, "file:test", {})).toThrow(/unknown field: heder/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ id: "x", typo: true }] }],
    }, "file:test", {})).toThrow(/unknown field: typo/);
  });

  it("缺少实例必填字段时指出字段路径", () => {
    const entry = instance() as Record<string, unknown>;
    delete entry.clientId;
    expect(() => parseConfigFile({ instances: [entry] }, "file:test", {})).toThrow(/instances\[0\]\.clientId/);
  });

  it("拒绝重复、非法及内置 provider id", () => {
    expect(() => parseConfigFile({ instances: [instance("same"), instance("same")] }, "file:test", {}))
      .toThrow(/duplicate/);
    expect(() => parseConfigFile({ instances: [instance("Bad/Id")] }, "file:test", {})).toThrow(/must match/);
    expect(() => parseConfigFile({ instances: [instance("anthropic")] }, "file:test", {})).toThrow(/built-in provider/);
    expect(() => parseConfigFile({ instances: [instance("radius")] }, "file:test", {})).toThrow(/built-in provider/);
    // omp 内置（pi-ai 18.1.3 registry）与本机在用的 provider
    expect(() => parseConfigFile({ instances: [instance("azure")] }, "file:test", {})).toThrow(/built-in provider/);
    expect(() => parseConfigFile({ instances: [instance("meta")] }, "file:test", {})).toThrow(/built-in provider/);
    expect(() => parseConfigFile({ instances: [instance("typesafe")] }, "file:test", {})).toThrow(/built-in provider/);
    expect(() => parseConfigFile({ instances: [instance("litellm")] }, "file:test", {})).toThrow(/built-in provider/);
  });

  it("拒绝 Object.prototype 属性名（models-store 原型链读取会 structuredClone 抛错）", () => {
    // constructor 是唯一能穿过小写 pattern 且命中原型链的属性名
    expect(() => parseConfigFile({ instances: [instance("constructor")] }, "file:test", {})).toThrow(/reserved property name/);
    // 驼峰原型属性名（toString/hasOwnProperty）与 __proto__ 被 pattern 先行拒绝，同样不可用
    expect(() => parseConfigFile({ instances: [instance("toString")] }, "file:test", {})).toThrow(/must match/);
    expect(() => parseConfigFile({ instances: [instance("hasOwnProperty")] }, "file:test", {})).toThrow(/must match/);
    expect(() => parseConfigFile({ instances: [instance("__proto__")] }, "file:test", {})).toThrow(/must match/);
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
    }, "file:test", {})).toThrow(/non-negative finite number/);
    expect(() => parseConfigFile({
      instances: [{ ...instance(), fallbackModels: [{ ...valid, contextWindow: 0 }] }],
    }, "file:test", {})).toThrow(/must be greater than 0/);
  });
});
