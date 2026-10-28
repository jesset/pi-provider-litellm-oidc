import { describe, expect, it } from "bun:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parseConfigFile } from "../extension/config.ts";
import { setupExtension } from "../extension/index.ts";
import { opaqueToken } from "./helpers.ts";

/**
 * 非 chat 模态接入（image_generation / image_edit / decisions）的集成接缝测试：
 * 从 setupExtension 进入，穿越 ProviderConfig 注册 → refreshModels（mock fetch 的
 * /model/info）→ 目录分流断言 → images/classifiers 实现的 wire 出口。
 * spec: GitLab issue #1；接缝方案经用户确认（fake-pi 集成层）。
 */

/** fake-pi 最小表面：捕获 registerProvider/registerCommand/on（先例 multi-instance.test.ts）。 */
function fakePi() {
  const providers = new Map<string, ProviderConfig>();
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const commands: Record<string, any> = {};
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
  } as unknown as Parameters<typeof setupExtension>[0];
  return { pi, providers, handlers, commands };
}

/** 单实例 RuntimeConfig（OIDC 实例，LiteLLM 形态）。 */
function runtimeConfig() {
  return parseConfigFile(
    {
      instances: [
        {
          id: "litellm",
          name: "LiteLLM Gateway",
          gatewayUrl: "https://litellm.example.com",
          keycloakUrl: "https://keycloak.example.com",
          realm: "Example",
          clientId: "coding-agent-cli",
        },
      ],
    },
    "file:test",
    {},
  );
}

/** mock refreshModels context（网络阶段 + oauth credential），返回捕获的 publish。 */
function mockRefreshContext() {
  const published: unknown[] = [];
  return {
    published,
    context: {
      allowNetwork: true,
      credential: {
        type: "oauth" as const,
        access: opaqueToken(),
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
      stored: undefined,
      signal: new AbortController().signal,
      publish: async (entry: unknown) => {
        published.push(entry);
      },
    },
  };
}

/** 替换全局 fetch 为按 URL 分发的 responder；返回捕获的请求与还原函数。 */
function mockFetch(respond: (url: string, init?: RequestInit) => Response) {
  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** /model/info 混合目录：chat + image_generation + evaluation + image_edit + 剔除类。 */
const MIXED_MODEL_INFO = {
  data: [
    { model_name: "claude-sonnet-5", model_info: { mode: "chat", max_input_tokens: 200000, max_output_tokens: 64000 } },
    { model_name: "flux3-klein", model_info: { mode: "image_generation" } },
    { model_name: "typesafe/jev-latest", model_info: { mode: "evaluation", max_input_tokens: 65536, input_cost_per_token: 3e-6 } },
    { model_name: "text-embed-v1", model_info: { mode: "embedding" } },
    { model_name: "whisper-large-v3", model_info: { mode: "audio_transcription" } },
  ],
};

/** /v1/systemone 实测响应（jev-1.14.0，2026-10-28，spec #1 证据链）。 */
const SYSTEMONE_RESPONSE = {
  model: "jev-1.14.0",
  answers: {
    is_refund: { type: "noul", noul: 0.99 },
    urgency: { type: "choice", choice: "high", confidence: 1.0, probabilities: { low: 0.0, high: 1.0 } },
    tone: { type: "score", score: 1, confidence: 0.8 },
  },
  usage: { input_tokens: 346, output_tokens: 50 },
};

/** 从捕获的 ProviderConfig 取 litellm-decisions 实现（接缝出口）。 */
function getClassifierImpl(providers: Map<string, ProviderConfig>) {
  return providers.get("litellm")!.classifiers!["litellm-decisions"]!.classify;
}

function classifierModel() {
  return {
    type: "classifier" as const,
    provider: "litellm",
    id: "typesafe/jev-latest",
    api: "litellm-decisions",
    input: ["text"],
    contextWindow: 65536,
    cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

describe("litellm-decisions.classify — System One wire（真实报文 fixture）", () => {
  const CONTEXT = {
    state: { message: "Customer wrote: charged twice for order #4411" },
    questions: {
      is_refund: {
        type: "bool" as const,
        instructions: "Is the customer asking for a refund?",
        criteria: { true: "asks for refund", false: "no refund ask" },
      },
      urgency: {
        type: "choice" as const,
        instructions: "How urgent is this?",
        criteria: { low: "can wait a week", high: "needs action today" },
      },
      tone: {
        type: "score" as const,
        instructions: "How frustrated is the customer?",
        criteria: ["calm", "mildly annoyed", "angry"],
      },
    },
  };

  it("POST {gateway}/systemone：bool↔noul 映射、answers 解析、usage 按 catalog 价回填", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const classify = getClassifierImpl(providers);

    const fetchMock = mockFetch((url) =>
      url.endsWith("/systemone")
        ? new Response(JSON.stringify(SYSTEMONE_RESPONSE), { status: 200 })
        : new Response("not found", { status: 404 })
    );
    try {
      const result = await classify(classifierModel() as any, CONTEXT, {
        apiKey: "oidc-token",
        signal: new AbortController().signal,
      } as any);

      // wire 请求：URL、Bearer、System One 形状（state 直传、bool→noul）
      expect(fetchMock.requests).toHaveLength(1);
      const req = fetchMock.requests[0];
      expect(req.url).toBe("https://litellm.example.com/systemone");
      expect((req.init?.headers as Record<string, string>).authorization).toBe("Bearer oidc-token");
      const body = JSON.parse(String(req.init?.body));
      expect(body).toEqual({
        model: "typesafe/jev-latest",
        state: CONTEXT.state,
        questions: {
          is_refund: { type: "noul", instructions: "Is the customer asking for a refund?", criteria: { true: "asks for refund", false: "no refund ask" } },
          urgency: { type: "choice", instructions: "How urgent is this?", criteria: { low: "can wait a week", high: "needs action today" } },
          tone: { type: "score", instructions: "How frustrated is the customer?", criteria: ["calm", "mildly annoyed", "angry"] },
        },
      });

      // 解析：noul→bool、choice/score 原样、usage（catalog 价 input 0.5/1M × 346 tokens）
      expect(result.stopReason).toBe("stop");
      expect(result.answers).toEqual({
        is_refund: { type: "bool", probability: 0.99 },
        urgency: { type: "choice", choice: "high", confidence: 1.0, probabilities: { low: 0.0, high: 1.0 } },
        tone: { type: "score", score: 1, confidence: 0.8 },
      });
      expect(result.usage).toMatchObject({ input: 346, output: 50, cacheRead: 0, cacheWrite: 0 });
      expect(result.usage?.cost.input).toBeCloseTo((0.5 / 1_000_000) * 346, 10);
    } finally {
      fetchMock.restore();
    }
  });

  it("HTTP 错误不 throw：stopReason error + errorMessage", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const classify = getClassifierImpl(providers);

    const fetchMock = mockFetch(() => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));
    try {
      const result = await classify(classifierModel() as any, CONTEXT, {
        apiKey: "t",
        signal: new AbortController().signal,
      } as any);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("500");
      expect(result.errorMessage).toContain("boom");
    } finally {
      fetchMock.restore();
    }
  });

  it("images 输入明确报错（System One 通道不支持图像）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const classify = getClassifierImpl(providers);

    const result = await classify(
      classifierModel() as any,
      { ...CONTEXT, images: [{ type: "image", data: "aaaa", mimeType: "image/png" }] },
      { apiKey: "t", signal: new AbortController().signal } as any,
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("图像");
  });
});

/** /v1/images/generations 实测响应骨架（flux3-klein，2026-10-28）。 */
const IMAGE_RESPONSE_B64 = {
  created: 1770000000,
  data: [{ b64_json: btoa("fake-png-bytes"), revised_prompt: "a tiny red paper crane", url: "" }],
  output_format: "png",
  size: "1024x1024",
  usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
};

const IMAGE_RESPONSE_URL = {
  created: 1770000000,
  data: [{ url: "https://cdn.example.com/gen/abc.png", revised_prompt: "" }],
};

const IMAGE_ERROR_500 = {
  error: {
    message: "litellm.APIConnectionError: APIConnectionError - Connection error.",
    type: "internal_server_error",
  },
};

function imageModel() {
  return {
    type: "image" as const,
    provider: "litellm",
    id: "flux3-klein",
    api: "litellm-images",
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function getImageImpl(providers: Map<string, ProviderConfig>) {
  return providers.get("litellm")!.images!["litellm-images"]!.generateImages;
}

describe("litellm-images.generateImages — OpenAI Images wire（真实报文 fixture）", () => {
  it("全 text 输入 → POST /images/generations JSON（b64_json 直出、Bearer、metadata 透传 size/n）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const generateImages = getImageImpl(providers);

    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/generations")
        ? new Response(JSON.stringify(IMAGE_RESPONSE_B64), { status: 200 })
        : new Response("not found", { status: 404 })
    );
    try {
      const result = await generateImages(
        imageModel() as any,
        { input: [{ type: "text", text: "a tiny red paper crane on a wooden desk" }] },
        { apiKey: "oidc-token", signal: new AbortController().signal, metadata: { size: "512x512", n: 1 } } as any,
      );

      const req = fetchMock.requests[0];
      expect(req.url).toBe("https://litellm.example.com/images/generations");
      expect((req.init?.headers as Record<string, string>).authorization).toBe("Bearer oidc-token");
      expect(JSON.parse(String(req.init?.body))).toEqual({
        model: "flux3-klein",
        prompt: "a tiny red paper crane on a wooden desk",
        n: 1,
        size: "512x512",
        response_format: "b64_json",
      });

      expect(result.stopReason).toBe("stop");
      expect(result.output).toEqual([
        { type: "image", data: IMAGE_RESPONSE_B64.data[0].b64_json, mimeType: "image/png" },
      ]);
      // 实测 usage 全 0 不回填
      expect(result.usage).toBeUndefined();
    } finally {
      fetchMock.restore();
    }
  });

  it("响应无 b64_json 时回落下载 url（含 content-type 推断 mimeType）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const generateImages = getImageImpl(providers);

    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/generations")
        ? new Response(JSON.stringify(IMAGE_RESPONSE_URL), { status: 200 })
        : url === IMAGE_RESPONSE_URL.data[0].url
          ? new Response(new Uint8Array([1, 2, 3, 4]), {
              status: 200,
              headers: { "content-type": "image/webp" },
            })
          : new Response("not found", { status: 404 })
    );
    try {
      const result = await generateImages(
        imageModel() as any,
        { input: [{ type: "text", text: "a watercolor fox" }] },
        { apiKey: "t", signal: new AbortController().signal } as any,
      );
      expect(result.stopReason).toBe("stop");
      const block = result.output[0] as any;
      expect(block.type).toBe("image");
      expect(block.mimeType).toBe("image/webp");
      expect(block.data).toBe(btoa(String.fromCharCode(1, 2, 3, 4)));
      expect(fetchMock.requests.map((r) => r.url)).toContain(IMAGE_RESPONSE_URL.data[0].url);
    } finally {
      fetchMock.restore();
    }
  });

  it("输入含 image block → POST /images/edits（multipart 携带图与 prompt）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const generateImages = getImageImpl(providers);

    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/edits")
        ? new Response(JSON.stringify(IMAGE_RESPONSE_B64), { status: 200 })
        : new Response("not found", { status: 404 })
    );
    try {
      const result = await generateImages(
        imageModel() as any,
        {
          input: [
            { type: "text", text: "make the fox red" },
            { type: "image", data: btoa("source-image"), mimeType: "image/png" },
          ],
        },
        { apiKey: "t", signal: new AbortController().signal } as any,
      );
      expect(result.stopReason).toBe("stop");

      const req = fetchMock.requests[0];
      expect(req.url).toBe("https://litellm.example.com/images/edits");
      const body = req.init?.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("model")).toBe("flux3-klein");
      expect(body.get("prompt")).toBe("make the fox red");
      expect(body.get("response_format")).toBe("b64_json");
      const image = body.get("image") as File;
      expect(image).toBeInstanceOf(File);
      expect(image.type).toBe("image/png");
    } finally {
      fetchMock.restore();
    }
  });

  it("HTTP 错误不 throw（实测 500 报文）：stopReason error + errorMessage", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const generateImages = getImageImpl(providers);

    const fetchMock = mockFetch(() =>
      new Response(JSON.stringify(IMAGE_ERROR_500), { status: 500 })
    );
    try {
      const result = await generateImages(
        imageModel() as any,
        { input: [{ type: "text", text: "boom" }] },
        { apiKey: "t", signal: new AbortController().signal } as any,
      );
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("500");
      expect(result.errorMessage).toContain("APIConnectionError");
    } finally {
      fetchMock.restore();
    }
  });

  it("无 text 输入报错（prompt 缺失）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const generateImages = getImageImpl(providers);
    const result = await generateImages(imageModel() as any, { input: [] }, {
      apiKey: "t",
      signal: new AbortController().signal,
    } as any);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("prompt");
  });
});

describe("refreshModels — mode 数据驱动分流（集成接缝）", () => {
  it("image_generation → image 条目、evaluation → classifier 条目、其余非 chat 照旧剔除", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const config = providers.get("litellm")!;

    const fetchMock = mockFetch((url) =>
      url.endsWith("/model/info")
        ? new Response(JSON.stringify(MIXED_MODEL_INFO), { status: 200 })
        : new Response("not found", { status: 404 })
    );
    try {
      const { published, context } = mockRefreshContext();
      const models = (await config.refreshModels!(context as any)) as any[];

      const byId = Object.fromEntries(models.map((m) => [m.id, m]));

      // chat 条目照旧
      expect(byId["claude-sonnet-5"]?.type).toBeUndefined();
      // image_generation 分流为 image 条目
      expect(byId["flux3-klein"]).toMatchObject({
        type: "image",
        api: "litellm-images",
        input: ["text"],
        output: ["image"],
      });
      // evaluation（decisions 同义 mode）分流为 classifier 条目
      expect(byId["typesafe/jev-latest"]).toMatchObject({
        type: "classifier",
        api: "litellm-decisions",
        input: ["text"],
        contextWindow: 65536,
      });
      // 网关 per-token（USD/token）换算为 pi ModelCost per-million 单位（spec 审查 P1 修复）
      expect(byId["typesafe/jev-latest"].cost.input).toBe(3);
      // 剔除类照旧
      expect(byId["text-embed-v1"]).toBeUndefined();
      expect(byId["whisper-large-v3"]).toBeUndefined();

      // 混合目录一次 publish persist
      expect(published).toHaveLength(1);
      const persisted = (published[0] as any).persist?.models as any[];
      expect(persisted.map((m) => m.id)).toEqual(["claude-sonnet-5", "flux3-klein", "typesafe/jev-latest"]);
    } finally {
      fetchMock.restore();
    }
  });

  it("同名 generation+edit 部署聚合为一条 image 条目，input 取并集", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const config = providers.get("litellm")!;

    const fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            { model_name: "flux3-klein", model_info: { mode: "image_generation" } },
            { model_name: "flux3-klein", model_info: { mode: "image_edit" } },
          ],
        }),
        { status: 200 },
      )
    );
    try {
      const { context } = mockRefreshContext();
      const models = (await config.refreshModels!(context as any)) as any[];
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: "flux3-klein",
        type: "image",
        api: "litellm-images",
        input: ["text", "image"],
        output: ["image"],
      });
    } finally {
      fetchMock.restore();
    }
  });

  it("隐藏过滤对非 chat 条目同样生效（staging/ 前缀、-openai 后缀）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const config = providers.get("litellm")!;

    const fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            { model_name: "staging/flux3-klein", model_info: { mode: "image_generation" } },
            { model_name: "jev-latest-openai", model_info: { mode: "evaluation" } },
          ],
        }),
        { status: 200 },
      )
    );
    try {
      const { context } = mockRefreshContext();
      const models = (await config.refreshModels!(context as any)) as any[];
      // 全部条目被隐藏过滤 → transformModelInfo 返回 null → 回落空 fallback 目录（文件实例默认 []）
      expect(models).toEqual([]);
    } finally {
      fetchMock.restore();
    }
  });

  it("离线阶段 stored 透传混合条目（image/classifier 不被丢掉）", async () => {
    const { pi, providers } = fakePi();
    setupExtension(pi, runtimeConfig());
    const config = providers.get("litellm")!;

    const stored = {
      models: [
        { id: "claude-sonnet-5", name: "claude-sonnet-5", input: ["text"], cost: {} },
        { type: "image", id: "flux3-klein", name: "flux3-klein", api: "litellm-images", input: ["text"], output: ["image"], cost: {} },
        { type: "classifier", id: "typesafe/jev-latest", name: "typesafe/jev-latest", api: "litellm-decisions", input: ["text"], cost: {}, contextWindow: 65536 },
      ],
      checkedAt: Date.now(),
    };
    const models = (await config.refreshModels!({
      allowNetwork: false,
      stored,
      signal: new AbortController().signal,
      publish: async () => {},
    } as any)) as any[];
    expect(models).toHaveLength(3);
    expect(models.filter((m) => m.type === "image")).toHaveLength(1);
    expect(models.filter((m) => m.type === "classifier")).toHaveLength(1);
  });
});
