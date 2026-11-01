import type {
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  ProviderClassifier,
  Usage,
} from "@earendil-works/pi-ai";import { trimTrailingSlash } from "./config.ts";
import type { InstanceConfig } from "./config.ts";

/**
 * litellm-decisions classifier 实现：System One wire 调 LiteLLM 网关 `/systemone` 端点。
 *
 * - wire 与 pi 内置 `typesafe-system-one` 同构（LiteLLM v1.106.4 源码 + 网关实测
 *   逐字段核对）：请求 `{model, state, questions: {id: {type: noul|choice|score,
 *   instructions, criteria}}}`，pi 侧 bool ↔ wire noul 双向映射；响应 `answers` keyed map。
 * - 不选 OpenAI Decisions 格式（/v1/decisions）：System One 与 pi 分类语义同构、keyed
 *   answers 比数组序防错；LiteLLM 对两种格式双向翻译，格式选择不影响模型可用性。
 * - 认证：不自取 token，以框架注入的 options.apiKey（OIDC access）加 Bearer；customer
 *   头经 modifyModels stamp 的 model.headers 兜底通道由框架 mergeHeaders 生效。
 * - 图像输入（条目 input 含 "image" 时）：System One assets 形态——state 变数组
 *   （`<image-N>` 引用在前 + 原 state）、assets map（PNG/JPEG 白名单，TypeSafe
 *   上游限制）、`TypeSafe-Danger-Zone-Images: true` opt-in 头（必须随图发送：网关
 *   drop_params 对无头请求静默剥离 assets，返回自信的错误答案（实测）；
 *   配方与 pi 内置 system-one-shared 的 assets 分支同构；jev-1.14.0
 *   512×512 实测 noul 判色正确、图像 token 计入 usage）。图像能力由网关
 *   supports_vision 声明驱动（all-true 聚合），未声明不宣传。
 * - 错误不 throw：一律按 ClassifierResult 形状返回（codemode 契约检查 stopReason）。
 * - usage 按 input_tokens/output_tokens 回填，cost 按 model.cost per-million 单位计算
 *   （pi catalog 惯例，openrouter-images 同款）；目录条目 cost 已在 transformModelInfo
 *   聚合时由网关 per-token 字段换算为 per-million 单位，此处直接可用。
 */

interface WireAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredNumber(id: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`litellm-decisions: ${id} is missing a valid numeric field`);
  }
  return value;
}

/** 按 context.questions 逐个解析 wire answers（keyed map）；畸形答案 throw → error result。 */
function parseAnswers(
  raw: unknown,
  questions: ClassifierContext["questions"],
): ClassifierResult["answers"] {
  if (!isRecord(raw)) throw new Error("litellm-decisions: response is missing the answers object");
  const answers: ClassifierResult["answers"] = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw[id];
    if (!isRecord(answer)) throw new Error(`litellm-decisions: response is missing an answer for ${id}`);
    if (question.type === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new Error(`litellm-decisions: ${id} did not return a choice answer`);
      }
      const probabilities = answer.probabilities;
      if (!isRecord(probabilities)) throw new Error(`litellm-decisions: ${id} is missing probabilities`);
      const parsed: Record<string, number> = {};
      for (const [key, probability] of Object.entries(probabilities)) {
        parsed[key] = requiredNumber(`${id}.${key}`, probability);
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: parsed,
        confidence: requiredNumber(`${id}.confidence`, answer.confidence),
      };
    } else if (question.type === "score") {
      if (answer.type !== "score") throw new Error(`litellm-decisions: ${id} did not return a score answer`);
      answers[id] = {
        type: "score",
        score: requiredNumber(`${id}.score`, answer.score),
        confidence: requiredNumber(`${id}.confidence`, answer.confidence),
      };
    } else {
      // pi bool ↔ wire noul
      answers[id] = { type: "bool", probability: requiredNumber(`${id}.noul`, answer.noul) };
    }
  }
  return answers;
}

/** usage 回填：input/output token + 按 model.cost（per-million）计 cost；缺 usage 时 undefined。 */
function parseUsage(raw: unknown, model: Pick<ClassifierModel<"litellm-decisions">, "cost">): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = typeof raw.input_tokens === "number" ? raw.input_tokens : 0;
  const output = typeof raw.output_tokens === "number" ? raw.output_tokens : 0;
  const cost = {
    input: (model.cost.input / 1_000_000) * input,
    output: (model.cost.output / 1_000_000) * output,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost,
  };
}

/** assets 形态的图像格式白名单（TypeSafe 上游仅接受 PNG/JPEG；mimeType → wire format）。 */
const ASSET_FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg" };

/** pi 侧 images（bool）→ wire questions（noul）；带图时 state 变数组、assets 附引用。 */
function wireRequest(context: ClassifierContext): {
  state: unknown;
  questions: Record<string, unknown>;
  assets?: Record<string, { type: string; format: string; data_base64: string }>;
} {
  const questions = Object.fromEntries(
    Object.entries(context.questions).map(([id, question]) => [
      id,
      question.type === "bool" ? { ...question, type: "noul" } : question,
    ]),
  );
  const images = context.images ?? [];
  if (images.length === 0) return { state: context.state, questions };
  const assets: Record<string, { type: string; format: string; data_base64: string }> = {};
  const refs: string[] = [];
  images.forEach((image, index) => {
    const format = ASSET_FORMATS[image.mimeType];
    if (!format) {
      throw new Error(
        `litellm-decisions: the assets form only accepts PNG/JPEG images (upstream TypeSafe limitation), got ${image.mimeType}`,
      );
    }
    const ref = `<image-${index + 1}>`;
    refs.push(ref);
    assets[ref] = { type: "image", format, data_base64: image.data };
  });
  // 每个资产必须被引用：引用名放在 state 前（pi 内置同款，与 Clef 的图像位置一致）
  return { state: [...refs, context.state], questions, assets };
}
export function createDecisionsClassifier(
  instance: Pick<InstanceConfig, "gatewayBaseUrl">,
): ProviderClassifier {
  const baseUrl = trimTrailingSlash(instance.gatewayBaseUrl);
  return {
    async classify(model, context, options): Promise<ClassifierResult> {
      const output: ClassifierResult = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers: {},
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        if (model.api !== "litellm-decisions") {
          throw new Error(`Unsupported classifier API: ${String(model.api)}`);
        }
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        if (context.images?.length) {
          if (!model.input.includes("image")) {
            throw new Error("litellm-decisions: this entry does not declare image input (gateway supports_vision is not declared true)");
          }
        }
        const wired = wireRequest(context);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        };
        if (wired.assets) {
          // opt-in 头必须随 assets 发送：无头时网关 drop_params 静默剥离图像，
          // 返回 200 与自信的错误答案（实测，风险最高的失败模式）
          headers["typesafe-danger-zone-images"] = "true";
        }
        const response = await fetch(`${baseUrl}/systemone`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: model.id,
            state: wired.state,
            questions: wired.questions,
            ...(wired.assets ? { assets: wired.assets } : {}),
          }),
          signal: options?.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `HTTP ${response.status} ${response.statusText} ${text.slice(0, 500)}`.trim(),
          );
        }
        const json: unknown = await response.json();
        if (!isRecord(json)) throw new Error("litellm-decisions: response is not a JSON object");
        // 先取 usage 再解析 answers：畸形答案的请求也已计费
        const usage = parseUsage(json.usage, model);
        if (usage) output.usage = usage;
        output.answers = parseAnswers(json.answers, context.questions);
        return output;
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        return output;
      }
    },
  };
}
