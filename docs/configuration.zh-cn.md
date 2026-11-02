# 配置参考

> English: [configuration.md](configuration.md)

本文覆盖标识注入、成本跟踪、模型列表策略与非 chat 模态。安装、基本使用与实例配置见 [README.zh-cn.md](../README.zh-cn.md)。

实例配置（必需环境变量、发现顺序与 `instances[]` 文件）见 [README.zh-cn.md](../README.zh-cn.md#配置)。本文覆盖网关接入的行为细节：

- [Session / Customer 标识注入](#session--customer-标识注入网关聚合与用户归因)
- [成本 / 用量可观测性](#成本--用量可观测性)
- [模型列表策略](#模型列表策略)
- [非 chat 模态](#非-chat-模态image--decisions)

## Session / Customer 标识注入（网关聚合与用户归因）

`before_provider_headers` 钩子给**已注册实例**的 LLM 请求注入两类标识，其他 provider 的请求不受影响：

1. **Session 标识**（Pi 会话 UUID）：把同一会话的多次请求（工具调用循环、重试、多 turn）聚合到同一 session。

   默认 header `x-litellm-trace-id` 是 LiteLLM proxy 原生解析链中优先级最高的会话/追踪头（`x-litellm-trace-id` > `x-litellm-session-id` > 任意 `x-<vendor>-session-id`），值会写入 `LiteLLM_SpendLogs.session_id` 列并同步 metadata 的 `trace_id`/`session_id`，Session Logs UI 按它分组，还会向嵌套 MCP/A2A 调用传播；网关侧零配置。注意：`x-session-id` 不匹配 LiteLLM 的 `^x-.+-session-id$` 通用正则（缺 vendor 段），会被网关完全忽略，故不作默认值。

2. **Customer 标识**（用户 email）：默认 header `x-litellm-customer-id`，LiteLLM proxy 的标准 customer/end-user 头（网关零配置即解析），值写入 SpendLogs 的 customer 维度；配合网关侧 `user_header_mappings` 与 `extra_spend_tag_headers` 可按用户 email 建用户、聚合个人用量。值直接取自框架已写入最终请求头的 `Authorization: Bearer <token>`（与实际发送的 token 严格同源，大小写不敏感解析），本地 base64url 解 JWT payload 取 `email` claim，不验签（同一 token 本就作为 bearer 发往网关，只是镜像一个 claim）；token 非 JWT、claim 缺失或未登录时跳过注入，不影响请求。

   Customer 头走**双通道**保证覆盖所有调用路径：
   - **会话主循环**（工具调用、多 turn、重试）经 `before_provider_headers` 钩子注入；
   - **模型级兜底**：`oauth.modifyModels` 在框架每次取模型目录时用当前 credential 把 customer 头写进每个 `model.headers`，这样**绕过会话钩子**的调用（第三方 SDK 客户端、其他扩展用裸 `pi-ai` streamSimple 直接调 LLM）经 pi-ai `createClient` 合并 `model.headers` 也同样携带。session 头仍只走钩子通道（session id 是会话级概念，不属于模型）。落盘的 models-store 只存原始目录、不含用户标识。

   > 排错提示：网关 SpendLogs 里 session_id 为随机 uuid 且单请求的“孤立 session”，多来自绕过钩子的后台调用（无 trace 头时 LiteLLM 会自动生成 uuid 作 session_id）；customer 头已覆盖到这类调用，但无 trace 头的请求仍不会有真实会话关联。

以下环境变量在 legacy 与配置文件模式下都生效；文件顶层的 `session` / `customer` 块可覆盖它们，实例内的 `customer` 还可按实例再覆盖。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_SESSION_HEADER` | `x-litellm-trace-id` | session 标识 header 名；显式设为空字符串可禁用注入 |
| `LITELLM_SESSION_PREFIX` | （空） | 可选前缀，例如 `pi-`；LiteLLM 要求值为 `^[a-zA-Z0-9_-]{8,}$`，前缀含 `.`/`:` 等字符会使 header 被网关丢弃 |
| `LITELLM_SESSION_CLIENT_HEADER` | （空） | 可选第二个 header 名（值固定 `pi`），用于网关侧客户端归因；不设置则不发送 |
| `LITELLM_CUSTOMER_HEADER` | `x-litellm-customer-id` | customer 标识 header 名；显式设为空字符串可禁用注入 |
| `LITELLM_CUSTOMER_CLAIM` | `email` | 依次尝试的 JWT claim 名，逗号分隔可配回退链，如 `email,preferred_username` |

行为要点：

- 重试复用相同 headers，钩子不会重复触发，session id 保持一致
- 多实例时，同一 session id 会发往各实例网关；两个网关各自形成独立的 SpendLogs 分组，不表示存在跨网关共享的会话存储
- `/fork`、`/clone` 生成新 session 文件与新 UUID；子代理与主会话共享同一 id
- `/new` 或 pi 重启后 id 变化；`pi -c` / `--session` 恢复会话保持原 id
- `x-litellm-trace-id` 解析链在 LiteLLM 2026-03 上游版本引入，网关版本较旧时 header 不被解析（注入无害但无聚合效果）；`x-litellm-customer-id` 是标准 customer 头，官方语义为“always checked without any configuration”，解析不依赖该版本

## 成本 / 用量可观测性

LiteLLM 在 `/v1/messages`（anthropic-messages 腿）响应头返回 `x-litellm-response-cost`（单次请求总成本）；扩展经两个钩子把它变成客户端可见的每轮成本：

- `after_provider_response`：读该头存入按 provider 隔离的 pending slot（无成本头的响应清 slot，防跨请求残留串扰）
- `message_end`：取 pending 总成本，按 input/output/cacheRead/cacheWrite token 比例摊到 `message.usage.cost`，返回替换消息——pi 与 omp 的每轮成本展示（omp 自带 $X.XX 渲染）均读 `usage.cost`

**pi + omp 均生效**：成本跟踪只用 `after_provider_response` + `message_end`，omp 两者皆有；不用 omp 缺的 `before_provider_headers`，因此与 session/customer 注入不同，omp 上也工作。与 session/customer 正交：后者是网关侧 spend 维度（session_id/customer_id），前者是客户端侧单次成本值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_COST_TRACKING` | （启用） | 是否启用成本跟踪；显式设为空字符串可禁用 |
| `LITELLM_COST_HEADER` | `x-litellm-response-cost` | 读取的响应头名；默认折扣后实付，可设 `x-litellm-response-cost-original` 取折扣前标价 |

## 模型列表策略

- 静态兜底目录按实例声明（`fallbackModels`，缺省为空），保证离线/失败时行为明确；模型级 header 值为字面值，`!` 前缀与 `$NAME`/`${NAME}` 片段在加载期拒绝（否则宿主框架会将其解析为配置值，执行命令或展开环境变量）
- 网络刷新成功的目录经 `context.publish({ persist })` 按 provider 持久化：pi 写入 `~/.pi/agent/models-store.json`，omp 写入 `models.db`；之后离线启动恢复各实例的真实目录前先重校验存储条目（剥离不可信键：丢弃 `baseUrl` / `headers`，删除无非空字符串 `id` 的条目——见 [ADR 0003](adr/0003-audit-run1-security-hardening.md)）
- `refreshModels` 遵守框架两阶段刷新协议：`allowNetwork=false`（扩展注册、每次 refresh 的 phase 1）零网络请求；网络阶段从 `context.credential` 取已刷新的 access token 调 `/model/info`（合并框架 abort signal 与本地 15s 超时）
- 数据源用 `/model/info` 而非 `/v1/models`：前者返回 deployment 级 DB 实配值（token limits、`supports_vision`、mode），后者的这些字段来自 LiteLLM 静态 cost map 按公开模型名查找——自研/别名模型一律缺失，会被误滤掉。要求网关把 `/model/info` 列入 `public_routes`（用户 JWT 可访问）
- 过滤与分流规则：`mode` 显式为 embedding/rerank/audio_transcription/audio_speech/video_generation/realtime/batch/ocr 的条目剔除（pi 无对应消费通道）；`image_generation`/`image_edit` 分流为 pi `type:"image"` 条目、`decisions`/`evaluation`（同义 mode）分流为 `type:"classifier"` 条目（见[非 chat 模态](#非-chat-模态image--decisions)）；mode 缺失不据此排除；隐藏 `-openai` 后缀条目（OpenAI 协议腿孪生，与 anthropic 腿重复）；同名多 deployment 聚合为一条（token 上限等标量字段取首个非空值，成本字段取 max 保守上界）
- 能力聚合 all-true（v0.10.0 起）：LiteLLM 同名组按 deployment 轮询，`supports_vision` 需全部 deployment 显式支持才宣传（未声明当不支持——轮到不支持的后端发图会 500）；`supports_reasoning` 任一显式 false 一票否决、全部显式 true 才直出、未声明混合回落兜底链。`input` 按 vision 判定决定是否含 image
- `model.cost` 从 `/model/info` 的 4 个 per-token 成本字段实配（`input_cost_per_token`/`output_cost_per_token`/`cache_read_input_token_cost`/`cache_creation_input_token_cost`，换算为 pi 的 USD/百万 token 后多 deployment 取 max 上界，缺失保持 0）——请求前估算与 `x-litellm-response-cost` 实付口径互补
- `reasoning` 四级回落推断：网关 `supports_reasoning` 声明层三态 → `reasoning_effort_levels`（档位存在即推理）→ `supported_openai_params` 含 `reasoning_effort`/`thinking` → 名字前缀正则 `REASONING_MODEL_PATTERN` 兜底
- 思考档位自动推导 + 菜单精确对齐（v0.10.1 起）：网关 `model_info` 的 `reasoning_effort_levels`（完整档集，同名多 deployment 取交集，未知档名忽略）或 `supports_{xhigh,max}_reasoning_effort` 布尔可精确声明档位——**有档位时菜单与档集精确对齐**：档集内的档直传自身 effort（选什么发什么），档集外的默认档以 `null` 从菜单显式排除，网关 `none` 档即 off（不含则 `off:null`——不发 disabled，对强制思考后端会 4xx，显式 off 请求 clamp 最低档）；**无档位（或同名组交集为空）**维持 `{ max: "max" }` 兜底（全菜单可选）。`forceAdaptiveThinking` 对全部推理模型保留（effort 传递通道：budget 路径无法表达档位枚举）。设计取舍见 [ADR 0001](adr/0001-align-thinking-menu-with-gateway-effort-levels.md)
- 未登录或拉取失败时回退该实例的持久化目录（重载时重校验——剥离不可信键）?? 静态兜底目录

## 非 chat 模态（image / decisions）

网关上部署的非 chat 模态对 pi 自动可见（mode 数据驱动，网关声明权威哲学的延伸）——网关部署什么，客户端无需发版即暴露什么：

- **图像生成/编辑**（mode `image_generation` / `image_edit`）：产出 pi image 模型条目，同名 generation+edit 部署聚为一条（edit 部署声明图像输入能力）。调用分流：输入全 text → `POST /v1/images/generations`（JSON，`response_format:"b64_json"`）；含 image block → `POST /v1/images/edits`（multipart）。响应 `b64_json` 直出，缺失时回落下载 `url`。`size`/`n`/`quality` 经 codemode 调用的 `options.metadata` 透传（size 默认 1024x1024）。图像模型不出现在 `/model` 选择器（pi by design），agent 经 codemode 调用：

  ```js
  // @options: {"timeout_ms": 300000}
  const painter = await models.getModelOfType("image", "my-gateway", "flux3-klein");
  const r = await models.generateImages(painter, {
    input: [{ type: "text", text: "a red fox in the snow, watercolor" }],
  });
  if (r.stopReason !== "stop") return r.errorMessage;
  for (const b of r.output) if (b.type === "image") image(b);
  ```

- **结构化决策**（mode `decisions` / `evaluation`，同义）：产出 pi classifier 模型条目，System One wire 调 `POST /v1/systemone`（bool↔noul 双向映射，answers 按 name keyed，usage token 回填并计入会话成本）。agent 经 codemode `models.classify()` 提 choice/score/bool 三型问题拿概率化答案。**图像输入**：条目 `input` 含 `"image"` 时可传 `images`（assets 形态：引用名前置到 state、PNG/JPEG 白名单、opt-in 头必发——网关会静默剥离无头请求的图像并返回错误答案）；图像能力由网关 `supports_vision` 声明驱动（同名组 all-true，显式 false 一票否决），网关未声明时可经实例级 `imageClassifiers: ["<model_name>"]` 名单兜底。注意 TypeSafe 上游图像尺寸下限约 320px：

  ```js
  const judge = await models.getModelOfType("classifier", "my-gateway", "typesafe/jev-latest");
  const r = await models.classify(judge, {
    state: { text: "Customer charged twice for order #4411" },
    questions: {
      refund: { type: "bool", instructions: "Is this a refund request?", criteria: { true: "yes", false: "no" } },
      urgency: { type: "choice", instructions: "How urgent?", criteria: { low: "can wait", high: "today" } },
    },
  });
  if (r.stopReason !== "stop") return r.errorMessage;
  return r.answers.refund.probability;  // 0.99
  ```

- 认证与 chat 同源：两实现共用实例 OIDC 凭证（框架 5min 窗口自动刷新后注入），customer 头经模型级 stamp 兜底通道自动携带；session 头不注入（stream-only hook 限制）
- `/session-header` 汇总各实例的模态清单（image × N、classifier × N）
- 成本现实：decisions 端点有真实 token 计数；images 端点实测 usage 全 0 且无 `x-litellm-response-cost`，单次成本按 0 兜底（`x-litellm-key-spend` 为 key 累计口径，不采用）
- 边界：embedding / rerank / audio 转写 / TTS / OCR / video / realtime 等 pi 无对应 ModelType，维持剔除
