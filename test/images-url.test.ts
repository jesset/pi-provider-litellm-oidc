import { describe, expect, it } from "bun:test";
import { createImagesApi } from "../extension/images.ts";

/**
 * generateImages url 回落下载的安全约束回归（审计 T2）：
 * data[].url 由网关/上游选择，下载前必须满足与其它出站 URL 相同的 origin 门槛
 * （assertSecureUrl：https 或回环 http；file: 等一律拒绝）、二次 fetch 不跟随
 * 跨 origin 重定向（redirect:"error"）、且只嵌入 content-type 为 image/* 的响应体。
 * 接缝为 createImagesApi 公开导出，fetch 以 stub 替换。
 */

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

function imageModel() {
  return {
    type: "image" as const,
    provider: "litellm-oidc",
    id: "flux3-klein",
    api: "litellm-images",
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function imagesApi() {
  return createImagesApi({ gatewayBaseUrl: "https://litellm.example.com" });
}

/** 网关 /images/generations 响应：data[0].url 指向 givenUrl（无 b64_json）。 */
function gatewayResponseWithUrl(givenUrl: string): Response {
  return new Response(JSON.stringify({ created: 1, data: [{ url: givenUrl }] }), { status: 200 });
}

async function generate(api: ReturnType<typeof imagesApi>) {
  return api.generateImages(imageModel() as any, { input: [{ type: "text", text: "a fox" }] }, {
    apiKey: "t",
    signal: new AbortController().signal,
  } as any);
}

describe("litellm-images url 回落下载 — 网关提供 URL 的 origin/内容类型约束", () => {
  it("非回环 http URL（169.254.169.254）下载前被拒：stopReason error、不发起第二次 fetch", async () => {
    const fetchMock = mockFetch((url) => gatewayResponseWithUrl("http://169.254.169.254/latest/meta-data/"));
    try {
      const result = await generate(imagesApi());
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("must use https");
      // 只有网关 POST，伪造目标从未被请求
      expect(fetchMock.requests).toHaveLength(1);
      expect(fetchMock.requests[0].url).toBe("https://litellm.example.com/images/generations");
      expect((result as any).output).toEqual([]);
    } finally {
      fetchMock.restore();
    }
  });

  it("file: URL 被拒（Bun host 本地文件读取面）：stopReason error、不发起第二次 fetch", async () => {
    const fetchMock = mockFetch((url) => gatewayResponseWithUrl("file:///etc/passwd"));
    try {
      const result = await generate(imagesApi());
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("must use https");
      expect(fetchMock.requests).toHaveLength(1);
      expect((result as any).output).toEqual([]);
    } finally {
      fetchMock.restore();
    }
  });

  it("二次 fetch 携带 redirect:\"error\"（不跟随跨 origin 重定向）", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/generations")
        ? gatewayResponseWithUrl("https://cdn.example.com/gen/abc.png")
        : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } })
    );
    try {
      const result = await generate(imagesApi());
      expect(result.stopReason).toBe("stop");
      const secondary = fetchMock.requests[1];
      expect(secondary.url).toBe("https://cdn.example.com/gen/abc.png");
      expect(secondary.init?.redirect).toBe("error");
    } finally {
      fetchMock.restore();
    }
  });

  it("下载响应 content-type 非 image/*（text/plain）时拒绝嵌入", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/generations")
        ? gatewayResponseWithUrl("https://cdn.example.com/gen/abc.bin")
        : new Response('{"AccessKeyId":"dummy"}', { status: 200, headers: { "content-type": "text/plain" } })
    );
    try {
      const result = await generate(imagesApi());
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("content-type");
      expect((result as any).output).toEqual([]);
    } finally {
      fetchMock.restore();
    }
  });

  it("下载响应缺失 content-type 时同样拒绝嵌入（无类型不进 transcript）", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/generations")
        ? gatewayResponseWithUrl("https://cdn.example.com/gen/abc")
        : new Response(new Uint8Array([9, 9, 9]), { status: 200 })
    );
    try {
      const result = await generate(imagesApi());
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("content-type");
      expect((result as any).output).toEqual([]);
    } finally {
      fetchMock.restore();
    }
  });

  it("回环 http URL 放行（与 assertSecureUrl 语义一致），image/* 正常嵌入", async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith("/images/generations")
        ? gatewayResponseWithUrl("http://127.0.0.1:18080/gen/abc.png")
        : new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "content-type": "image/png" } })
    );
    try {
      const result = await generate(imagesApi());
      expect(result.stopReason).toBe("stop");
      const block = (result as any).output[0];
      expect(block.type).toBe("image");
      expect(block.mimeType).toBe("image/png");
      expect(block.data).toBe(btoa(String.fromCharCode(4, 5, 6)));
    } finally {
      fetchMock.restore();
    }
  });
});
