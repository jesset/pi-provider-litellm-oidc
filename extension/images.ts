import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions, ProviderImages, Usage } from "@earendil-works/pi-ai";
import { trimTrailingSlash } from "./config.ts";
import type { InstanceConfig } from "./config.ts";

/**
 * litellm-images 图像生成实现：OpenAI Images wire 调 LiteLLM 网关。
 *
 * - 全 text 输入 → `POST {gateway}/images/generations`（JSON：model/prompt/n/size，
 *   response_format:"b64_json"）；输入含 image block → `POST {gateway}/images/edits`
 *   （multipart form，OpenAI 兼容；spec #1：无真实 image_edit 部署可验证，按协议实现）。
 * - size/n/quality 经 options.metadata 透传（pi 对该字段的官方契约即参数透传通道）；
 *   size 默认 1024x1024（t2i 网关实测需要显式 size），n 默认 1。
 * - 响应 data[] 每项：b64_json 直出；缺失时回落下载 url（content-type 推断 mimeType）。
 * - usage 仅在有非零 token 时回填（实测 t2i 网关 usage 全 0；单次成本头不可得：
 *   无 x-litellm-response-cost，x-litellm-key-spend 为 key 累计口径，均不采用）。
 * - 认证同 litellm-decisions：options.apiKey（OIDC access）+ Bearer；customer 头经
 *   model.headers 兜底通道由框架生效。错误不 throw，按 AssistantImages 形状返回。
 */

/** t2i 系网关（ComfyUI 转译）实测需要显式 size，OpenAI 官方端点可省略，统一发默认值。 */
const DEFAULT_SIZE = "1024x1024";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** mimeType → 文件扩展名（multipart image 文件名用；OpenAI 端点按 content-type 判断）。 */
function extensionOf(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function bytesFromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** usage 仅在有非零 token 时回填；cost 按 model.cost per-million（pi catalog 惯例）。 */
function parseUsage(raw: unknown, model: Pick<ImageModel<"litellm-images">, "cost">): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = typeof raw.input_tokens === "number" ? raw.input_tokens : 0;
  const output = typeof raw.output_tokens === "number" ? raw.output_tokens : 0;
  if (input === 0 && output === 0) return undefined;
  const cost = {
    input: (model.cost.input / 1_000_000) * input,
    output: (model.cost.output / 1_000_000) * output,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output;
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost };
}

export function createImagesApi(instance: Pick<InstanceConfig, "gatewayBaseUrl">): ProviderImages {
  const baseUrl = trimTrailingSlash(instance.gatewayBaseUrl);
  return {
    async generateImages(model, context, options?): Promise<AssistantImages> {
      const output: AssistantImages = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        if (model.api !== "litellm-images") {
          throw new Error(`Unsupported image API: ${String(model.api)}`);
        }
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const signal = options?.signal;
        const parts: (TextBlock | ImageBlock)[] = context?.input ?? [];
        const prompt = parts
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (!prompt) {
          throw new Error("litellm-images: prompt 缺失（context.input 需至少含一个 text block）");
        }
        const metadata = isRecord(options?.metadata) ? options!.metadata : {};
        const size = typeof metadata.size === "string" ? metadata.size : DEFAULT_SIZE;
        const n = typeof metadata.n === "number" && metadata.n > 0 ? metadata.n : 1;
        const quality = typeof metadata.quality === "string" ? metadata.quality : undefined;

        const imageBlocks = parts.filter((b): b is ImageBlock => b.type === "image");
        let response: Response;
        if (imageBlocks.length > 0) {
          // 图像输入 → 编辑端点（multipart）
          const form = new FormData();
          form.set("model", model.id);
          form.set("prompt", prompt);
          form.set("n", String(n));
          form.set("size", size);
          form.set("response_format", "b64_json");
          if (quality) form.set("quality", quality);
          for (const [index, block] of imageBlocks.entries()) {
            form.append(
              "image",
              new File([bytesFromBase64(block.data)], `input-${index}.${extensionOf(block.mimeType)}`, {
                type: block.mimeType,
              }),
            );
          }
          response = await fetch(`${baseUrl}/images/edits`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            body: form,
            signal,
          });
        } else {
          const body: Record<string, unknown> = {
            model: model.id,
            prompt,
            n,
            size,
            response_format: "b64_json",
          };
          if (quality) body.quality = quality;
          response = await fetch(`${baseUrl}/images/generations`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `HTTP ${response.status} ${response.statusText} ${text.slice(0, 500)}`.trim(),
          );
        }

        const json: unknown = await response.json();
        const items = isRecord(json) && Array.isArray(json.data) ? json.data : [];
        if (items.length === 0) {
          throw new Error(`litellm-images: 响应缺少 data 数组: ${JSON.stringify(json).slice(0, 300)}`);
        }
        for (const item of items) {
          if (!isRecord(item)) continue;
          let data: string | undefined = typeof item.b64_json === "string" ? item.b64_json : undefined;
          let mimeType = "image/png";
          if (!data && typeof item.url === "string") {
            // 部分网关返回 URL 而非内联 base64，回落下载
            const imageResponse = await fetch(item.url, { signal });
            if (!imageResponse.ok) {
              throw new Error(`下载生成图片失败: HTTP ${imageResponse.status}`);
            }
            data = bytesToBase64(new Uint8Array(await imageResponse.arrayBuffer()));
            const contentType = imageResponse.headers.get("content-type");
            if (contentType?.startsWith("image/")) mimeType = contentType;
          }
          if (!data) {
            throw new Error("litellm-images: 响应项既无 b64_json 也无 url");
          }
          output.output.push({ type: "image", data, mimeType });
        }

        const usage = parseUsage(isRecord(json) ? json.usage : undefined, model);
        if (usage) output.usage = usage;
        return output;
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        return output;
      }
    },
  };
}
