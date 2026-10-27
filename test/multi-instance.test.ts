import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parseConfigFile } from "../extension/config.ts";
import { setupExtension } from "../extension/index.ts";
import { makeJwt } from "./helpers.ts";

function fakePi() {
  const providers = new Map<string, ProviderConfig>();
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const pi = {
    registerProvider(id: string, config: ProviderConfig) {
      providers.set(id, config);
    },
    on(event: string, handler: any) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand(name: string, command: any) {
      commands[name] = command;
    },
  } as unknown as ExtensionAPI;
  const emit = async (event: string, payload: any, ctx: any = {}) => {
    let result: any;
    for (const handler of handlers[event] ?? []) result = await handler(payload, ctx);
    return result;
  };
  return { pi, providers, handlers, commands, emit };
}

function runtimeConfig() {
  return parseConfigFile({
    instances: [
      {
        id: "litellm",
        name: "LiteLLM Gateway",
        gatewayUrl: "https://litellm.example.com",
        keycloakUrl: "https://keycloak.example.com",
        realm: "Example",
        clientId: "coding-agent-cli",
      },
      {
        id: "staging",
        name: "Staging Gateway",
        gatewayUrl: "https://gateway.staging.example.com",
        keycloakUrl: "https://sso.staging.example.com",
        realm: "Staging",
        clientId: "staging-cli",
        customer: { header: "x-staging-user", claims: ["preferred_username"] },
      },
    ],
    session: { prefix: "pi-", clientHeader: "x-pi-client" },
  }, "file:test", {});
}

describe("多实例扩展装配", () => {
  it("注册独立 provider，并按实例分发 customer / session 头与成本", async () => {
    const { pi, providers, handlers, emit } = fakePi();
    setupExtension(pi, runtimeConfig());

    expect([...providers.keys()]).toEqual(["litellm", "staging"]);
    expect(providers.get("litellm")?.baseUrl).toBe("https://litellm.example.com");
    expect(providers.get("staging")?.baseUrl).toBe("https://gateway.staging.example.com");
    expect(providers.get("staging")?.models).toEqual([]);
    expect(handlers.before_provider_headers).toHaveLength(1);
    expect(handlers.after_provider_response).toHaveLength(1);
    expect(handlers.message_end).toHaveLength(1);

    const stagingCredentials = {
      access: makeJwt({ email: "ignored@example.com", preferred_username: "alice" }),
      refresh: "refresh",
      expires: Date.now() + 60_000,
    };
    const stamped = providers.get("staging")?.oauth?.modifyModels([{ id: "smart" } as any], stagingCredentials);
    expect(stamped?.[0].headers).toEqual({ "x-staging-user": "alice" });

    const event = {
      headers: { Authorization: `Bearer ${stagingCredentials.access}` } as Record<string, string | null>,
    };
    await emit("before_provider_headers", event, {
      model: { provider: "staging" },
      sessionManager: { getSessionId: () => "session-123" },
    });
    expect(event.headers).toMatchObject({
      "x-litellm-trace-id": "pi-session-123",
      "x-pi-client": "pi",
      "x-staging-user": "alice",
    });
    expect(event.headers["x-litellm-customer-id"]).toBeUndefined();

    const unrelated = { headers: { Authorization: `Bearer ${stagingCredentials.access}` } };
    await emit("before_provider_headers", unrelated, { model: { provider: "openai" } });
    expect(unrelated.headers["x-litellm-trace-id"]).toBeUndefined();
    expect(unrelated.headers["x-staging-user"]).toBeUndefined();

    await emit("after_provider_response", {
      status: 200,
      headers: { "x-litellm-response-cost": "0.4" },
    }, { model: { provider: "staging" } });
    const message = await emit("message_end", {
      message: { role: "assistant", provider: "staging", usage: { input: 10, output: 30 } },
    });
    expect(message.message.usage.cost.total).toBe(0.4);
  });

  it("provider 的 Device Flow 使用各自 Keycloak、realm 与 client", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    const bodies: string[] = [];
    let deviceCode: any;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        bodies.push(String(init?.body));
        if (urls.length === 1) {
          return new Response(JSON.stringify({
            device_code: "device-code",
            user_code: "USER-CODE",
            verification_uri: "https://sso.staging.example.com/device",
            interval: 0,
            expires_in: 60,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "staging-access",
          refresh_token: "staging-refresh",
          expires_in: 300,
        }), { status: 200 });
      }) as typeof fetch;

      const credentials = await providers.get("staging")?.oauth?.login({
        onDeviceCode: (info: any) => { deviceCode = info; },
        signal: new AbortController().signal,
      } as any);
      expect(credentials).toMatchObject({ access: "staging-access", refresh: "staging-refresh" });
      expect(deviceCode.userCode).toBe("USER-CODE");
      expect(urls).toEqual([
        "https://sso.staging.example.com/realms/Staging/protocol/openid-connect/auth/device",
        "https://sso.staging.example.com/realms/Staging/protocol/openid-connect/token",
      ]);
      expect(new URLSearchParams(bodies[0]).get("client_id")).toBe("staging-cli");
      expect(new URLSearchParams(bodies[1]).get("code_verifier")).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("/session-header 汇总配置来源与各实例登录状态", async () => {
    const { pi, commands } = fakePi();
    setupExtension(pi, runtimeConfig());
    const notifications: string[] = [];
    await commands["session-header"].handler("", {
      hasUI: true,
      ui: { notify: (text: string) => notifications.push(text) },
      sessionManager: { getSessionId: () => "session-123" },
      modelRegistry: {
        getApiKeyForProvider: async (provider: string) => provider === "litellm"
          ? makeJwt({ email: "cloud@example.com" })
          : makeJwt({ preferred_username: "alice" }),
      },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("配置来源 : file:test");
    expect(notifications[0]).toContain("[litellm] LiteLLM Gateway");
    expect(notifications[0]).toContain("cloud@example.com");
    expect(notifications[0]).toContain("[staging] Staging Gateway");
    expect(notifications[0]).toContain("x-staging-user: alice");
  });

  it("refreshModels 两阶段：phase 1 零网络恢复各自 stored，网络阶段各自拉取并隔离持久化", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const storedModel = { id: "stored-model", name: "stored-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
    const litellm = providers.get("litellm")!;
    const staging = providers.get("staging")!;

    // phase 1（allowNetwork=false）：各自恢复 stored，绝不打网络；无 stored 时用各自 fallback（文件实例为空）
    const offlineA = await litellm.refreshModels!({
      allowNetwork: false,
      stored: { models: [storedModel], checkedAt: 1 } as any,
      publish: async () => false,
      signal: new AbortController().signal,
    } as any);
    const offlineB = await staging.refreshModels!({
      allowNetwork: false,
      stored: undefined,
      publish: async () => false,
      signal: new AbortController().signal,
    } as any);
    expect(offlineA.map((model) => model.id)).toEqual(["stored-model"]);
    expect(offlineB).toEqual([]);

    // 网络阶段：各实例拉各自的 /model/info，persist 按实例隔离
    const realFetch = globalThis.fetch;
    const persistCalls: Array<{ models: unknown[]; publish: (publication: unknown) => Promise<boolean> }> = [];
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        const models = url.includes("example.com")
          ? [{ model_name: "litellm-live", model_info: {} }]
          : [{ model_name: "staging-live", model_info: {} }];
        return new Response(JSON.stringify({ data: models }), { status: 200 });
      }) as typeof fetch;

      for (const [id, provider] of [["litellm", litellm], ["staging", staging]] as const) {
        const published: unknown[] = [];
        const result = await provider.refreshModels!({
          allowNetwork: true,
          credential: { type: "oauth", access: `${id}-token`, refresh: "r", expires: Date.now() + 60_000 },
          publish: (publication: any) => {
            published.push(publication.persist);
            return Promise.resolve(true);
          },
          signal: new AbortController().signal,
        } as any);
        expect(result.map((model) => model.id)).toEqual([`${id}-live`]);
        expect(published).toHaveLength(1);
        persistCalls.push({ models: (published[0] as any).models, publish: publication => Promise.resolve(true) });
      }
      expect(persistCalls[0].models.map((m: any) => m.id)).toEqual(["litellm-live"]);
      expect(persistCalls[1].models.map((m: any) => m.id)).toEqual(["staging-live"]);
    } finally {
      globalThis.fetch = realFetch;
    }

    // 网络失败（非 2xx）回落 stored ?? 各自 fallback：litellm 有 stored 恢复、staging 无 stored 得空数组
    globalThis.fetch = (async () => new Response("boom", { status: 502 })) as typeof fetch;
    try {
      const failedA = await litellm.refreshModels!({
        allowNetwork: true,
        credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
        stored: { models: [storedModel], checkedAt: 1 } as any,
        publish: async () => false,
        signal: new AbortController().signal,
      } as any);
      const failedB = await staging.refreshModels!({
        allowNetwork: true,
        credential: { type: "oauth", access: "b", refresh: "r", expires: Date.now() + 60_000 },
        stored: undefined,
        publish: async () => false,
        signal: new AbortController().signal,
      } as any);
      expect(failedA.map((model) => model.id)).toEqual(["stored-model"]);
      expect(failedB).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
