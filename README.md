# pi-provider-litellm-oidc

Pi coding agent 通过 Keycloak OIDC 免密钥（keyless）接入 LiteLLM 网关的 provider 扩展：经 Device Authorization Flow（RFC 8628）取得 JWT，以 `Authorization: Bearer` 调用网关的 Anthropic 协议端点 `/v1/messages`，全程无静态 API Key。一套代码同时适配 [pi](https://github.com/earendil-works/pi) 与 omp（oh-my-pi）。

扩展不自带任何部署默认值：网关地址、Keycloak realm 与 client 都由部署方提供——环境变量用于单实例，JSON 配置文件用于同一 pi / omp 进程内的多实例接入。

## 架构

```
pi / omp
  │
  │ LITELLM_OIDC_*（单实例）或 litellm-oidc.json（instances[]）
  │    └─ loadRuntimeConfig → 每个 Instance 独立 registerProvider
  │
  │ /login <provider> ──→ 该实例的 oauth.login(callbacks)
  │    1. POST {keycloak}/realms/{realm}/protocol/openid-connect/auth/device
  │       (公共客户端, scope="openid profile email offline_access")
  │    2. 展示设备码——按回调能力三级探测：
  │       onDeviceCode() → pi 原生设备码对话框
  │       onAuth()       → omp LoginDialog（verificationUri + userCode）
  │       notify()       → 新 AuthInteraction 通道（自动生效）
  │    3. 轮询 token endpoint（grant_type=urn:ietf:params:oauth:grant-type:device_code）
  │    4. 返回 {access, refresh, expires}，框架按 provider 持久化：
  │       pi → ~/.pi/agent/auth.json；omp → auth_credentials 表
  │
  │ 请求时（框架按 provider 管理）：
  │    - access token 临过期（5min 窗口）→ 该实例 oauth.refreshToken() → Keycloak refresh_token grant
  │    - authHeader: true → Authorization: Bearer <JWT>
  ▼
各实例自己的 LiteLLM 网关 (enable_jwt_auth + JWKS 指向对应 Keycloak)
  └─ /v1/messages（api: "anthropic-messages"）
```

## 安装

### npm（推荐）

```bash
# pi
pi install npm:pi-provider-litellm-oidc

# omp（内置 pi 兼容的插件加载器，语法相同）
omp install npm:pi-provider-litellm-oidc
```

npm 通道拿到的是 minified 单文件产物（`dist/index.js`），不含 TS 源码。

### git 源

```bash
# scp 简写必须带 git@，否则 Pi 会把 spec 当成本地路径
pi install git:git@github.com:jesset/pi-provider-litellm-oidc.git@v0.13.0
```

> git 源安装会在本机 clone 完整源码并经 `prepare` 钩子现场构建 dist（需 Node ≥ 22 与可达 npm registry 拉 esbuild）——拿到的是源码，防篡改保护只存在于 npm 通道；对普通用户推荐 npm 方式。

### 本地目录

```bash
git clone https://github.com/jesset/pi-provider-litellm-oidc.git
cd pi-provider-litellm-oidc
npm install --no-audit --no-fund   # prepare 会构建 dist/index.js
./install.sh                       # pi install <本地目录>
```

已运行中的 Pi 会话用 `/reload` 热加载。

### Keycloak 侧前置要求

- 公共客户端，启用 OAuth 2.0 Device Authorization Grant
- **PKCE（v0.9.1 起）**：device 授权请求携带 `code_challenge`（S256）、token 轮询携带 `code_verifier`（RFC 7636）。Keycloak 26 起 admin console 对 public client 默认强制 PKCE（client 属性 `pkceCodeChallengeMethod=S256`）——扩展已实现该基线，无需在服务端关闭；旧版 Keycloak 忽略这些参数。报 `Missing parameter: code_challenge_method` 说明用的是更早版本，升级即可
- Client scope 含 `offline_access`（长时 refresh token 的必要条件）
- LiteLLM 网关 `JWT_PUBLIC_KEY_URL` 指向该 realm 的 JWKS，`enable_jwt_auth: true`

## 使用

```text
/login my-gateway            # 登录单实例（Device Flow 在任意设备浏览器完成）
/model my-gateway/<model-id>
/logout my-gateway           # 只清除该实例凭据

# 配置 instances[] 后，每个实例有独立的登录、模型与凭据命名空间
/login staging
/model staging/<model-id>
/logout staging              # 不影响 my-gateway

/session-header              # 查看配置来源、各实例登录状态、模态清单与 session / customer 注入
```

## 配置

### 单实例：环境变量

未发现配置文件时，用环境变量定义一个实例。**扩展不提供任何部署默认值**，缺少下列任一必需变量时加载即失败并打印配置示例：

| 变量 | 必需 | 说明 |
|---|---|---|
| `LITELLM_OIDC_PROVIDER_ID` | ✓ | Pi provider ID（`/login`、`--model` 的前缀），小写字母或数字开头，不能与 pi / omp 内置 provider 同名 |
| `LITELLM_OIDC_GATEWAY_URL` | ✓ | LiteLLM 网关地址（必须 `https://`） |
| `LITELLM_OIDC_KEYCLOAK_URL` | ✓ | Keycloak 根地址（必须 `https://`） |
| `LITELLM_OIDC_KEYCLOAK_REALM` | ✓ | realm 名 |
| `LITELLM_OIDC_KEYCLOAK_CLIENT_ID` | ✓ | OAuth 公共客户端 ID |
| `LITELLM_OIDC_DISPLAY_NAME` | | UI 显示名，缺省与 provider ID 相同 |
| `LITELLM_OIDC_KEYCLOAK_SCOPE` | | 默认 `openid profile email offline_access` |

```bash
export LITELLM_OIDC_PROVIDER_ID=my-gateway
export LITELLM_OIDC_GATEWAY_URL=https://litellm.example.com
export LITELLM_OIDC_KEYCLOAK_URL=https://keycloak.example.com
export LITELLM_OIDC_KEYCLOAK_REALM=myrealm
export LITELLM_OIDC_KEYCLOAK_CLIENT_ID=coding-agent-cli
pi
```

环境变量写法：`~/.pi/agent/settings.json` 的 `env` 块、shell profile、或启动时 `LITELLM_OIDC_...=... pi`。

> **HTTPS 强制（v0.10.0 起）**：`LITELLM_OIDC_GATEWAY_URL` / `LITELLM_OIDC_KEYCLOAK_URL`，以及配置文件的 `gatewayUrl` / `keycloakUrl` / `fallbackModels[].baseUrl` 必须使用 `https://`——误配 `http://` 会让 JWT 与 refresh token 明文过线，扩展在加载时直接报错；唯一例外是 loopback 主机（`localhost`、IPv4 字面量 `127.0.0.0/8`、`[::1]`，本地调试代理；`127.*` 域名不属于例外）。
>
> **refresh 瞬态失败 backoff（v0.10.0 起）**：Keycloak 瞬断/限流时，框架 credential lock 后排队的刷新调用会形成惊群。扩展按实例与 refresh token 记录 5s backoff 窗口，窗口内直接返回未过期的旧凭据；仅瞬态异常（网络/解析层）记录 backoff，OAuth 语义错误（如 `invalid_grant`）照常抛出以强制重新 `/login`，旧 token 已过期时不 backoff。

### 多实例：JSON 配置文件（v0.11.0 起）

配置文件可在一个 pi / omp 进程中注册多个独立 provider。每个实例拥有自己的网关、Keycloak、凭据和模型目录；文件存在时 `instances[]` **完全取代** `LITELLM_OIDC_*` 实例变量，不做合并。

发现顺序：

1. `LITELLM_OIDC_CONFIG=/path/to/litellm-oidc.json`（相对路径按当前工作目录解析）；
2. `$PI_CODING_AGENT_DIR/litellm-oidc.json`；
3. 运行时默认路径：pi 为 `~/.pi/agent/litellm-oidc.json`；omp 按 `PI_CONFIG_DIR` 与 `OMP_PROFILE` / `PI_PROFILE` 推导，默认为 `~/.omp/agent/litellm-oidc.json`。`execPath` 为 `omp` 时只查 omp 路径，为 `pi` / `node` 时只查 pi 路径；omp 以 `#!/usr/bin/env bun` 脚本分发，bun 或其他无法判定宿主的 execPath 按 pi → omp 顺序探测并输出一条告警；
4. 均未发现时回退到环境变量单实例。

显式路径不存在、JSON 非法或任一实例字段错误都会使扩展加载失败，不会静默回退。修改文件后执行 `/reload` 生效。若 pi 与 omp 的默认路径同时存在配置，bun 宿主下取上述顺序的第一个命中项；需要消除歧义时显式设置 `LITELLM_OIDC_CONFIG` 或 `PI_CODING_AGENT_DIR`。

```json
{
  "instances": [
    {
      "id": "my-gateway",
      "name": "My LiteLLM Gateway",
      "gatewayUrl": "https://litellm.example.com",
      "keycloakUrl": "https://keycloak.example.com",
      "realm": "myrealm",
      "clientId": "coding-agent-cli"
    },
    {
      "id": "staging",
      "name": "Staging Gateway",
      "gatewayUrl": "https://litellm-staging.example.com",
      "keycloakUrl": "https://keycloak-staging.example.com",
      "realm": "staging",
      "clientId": "staging-cli",
      "scope": "openid profile email offline_access",
      "modelInfoPath": "/model/info",
      "customer": { "claims": ["email", "preferred_username"] },
      "fallbackModels": [
        {
          "id": "claude-sonnet-5",
          "name": "Claude Sonnet 5",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 64000,
          "thinkingLevelMap": { "max": "max" },
          "compat": { "forceAdaptiveThinking": true }
        }
      ]
    }
  ],
  "session": { "header": "x-litellm-trace-id", "prefix": "pi-" },
  "customer": { "header": "x-litellm-customer-id", "claims": ["email"] },
  "cost": { "enabled": true, "header": "x-litellm-response-cost" }
}
```

实例必填字段：`id`、`name`、`gatewayUrl`、`keycloakUrl`、`realm`、`clientId`。`scope` 默认 `openid profile email offline_access`，`modelInfoPath` 默认 `/model/info`。`id` 必须全局唯一、小写字母或数字开头且不含 `/`，不能是 `constructor` 等原型链保留属性名，也不能覆盖 pi / omp 内置 provider（保留名单为两侧框架 registry 的并集，随运行时升级需同步）。

各实例的凭据与模型目录按 `id` 隔离：pi 分别存入 `~/.pi/agent/auth.json` 与 `~/.pi/agent/models-store.json` 的对应 provider 键；omp 分别存入 `auth_credentials` 表与 `models.db` 的对应 provider 作用域。

`fallbackModels` 缺省为空数组——扩展不内置任何模型目录，离线静态目录必须按完整 `ProviderModelConfig` 显式声明。`fallbackModels[].baseUrl` 会覆盖该模型的请求地址，同样必须通过 HTTPS 校验。`compat` 的字段与枚举由运行时框架定义，扩展只做浅层 JSON 值校验，未识别字段可能被框架忽略。

顶层可选 `session`、`customer`、`cost` 块用于覆盖对应的全局环境变量：`session` 支持 `header` / `prefix` / `clientHeader`，`customer` 支持 `header` / `claims`，`cost` 支持 `enabled` / `header`。实例内仅 `customer` 可继续覆盖，`session` 与 `cost` 保持全局。

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

- 静态兜底目录按实例声明（`fallbackModels`，缺省为空），保证离线/失败时行为明确
- 网络刷新成功的目录经 `context.publish({ persist })` 按 provider 持久化：pi 写入 `~/.pi/agent/models-store.json`，omp 写入 `models.db`；之后离线启动直接恢复各实例的真实目录
- `refreshModels` 遵守框架两阶段刷新协议：`allowNetwork=false`（扩展注册、每次 refresh 的 phase 1）零网络请求；网络阶段从 `context.credential` 取已刷新的 access token 调 `/model/info`（合并框架 abort signal 与本地 15s 超时）
- 数据源用 `/model/info` 而非 `/v1/models`：前者返回 deployment 级 DB 实配值（token limits、`supports_vision`、mode），后者的这些字段来自 LiteLLM 静态 cost map 按公开模型名查找——自研/别名模型一律缺失，会被误滤掉。要求网关把 `/model/info` 列入 `public_routes`（用户 JWT 可访问）
- 过滤与分流规则：`mode` 显式为 embedding/rerank/audio_transcription/audio_speech/video_generation/realtime/batch/ocr 的条目剔除（pi 无对应消费通道）；`image_generation`/`image_edit` 分流为 pi `type:"image"` 条目、`decisions`/`evaluation`（同义 mode）分流为 `type:"classifier"` 条目（见「非 chat 模态」）；mode 缺失不据此排除；隐藏 `-openai` 后缀条目（OpenAI 协议腿孪生，与 anthropic 腿重复）；同名多 deployment 聚合为一条（token 上限等标量字段取首个非空值，成本字段取 max 保守上界）
- 能力聚合 all-true（v0.10.0 起）：LiteLLM 同名组按 deployment 轮询，`supports_vision` 需全部 deployment 显式支持才宣传（未声明当不支持——轮到不支持的后端发图会 500）；`supports_reasoning` 任一显式 false 一票否决、全部显式 true 才直出、未声明混合回落兜底链。`input` 按 vision 判定决定是否含 image
- `model.cost` 从 `/model/info` 的 4 个 per-token 成本字段实配（`input_cost_per_token`/`output_cost_per_token`/`cache_read_input_token_cost`/`cache_creation_input_token_cost`，换算为 pi 的 USD/百万 token 后多 deployment 取 max 上界，缺失保持 0）——请求前估算与 `x-litellm-response-cost` 实付口径互补
- `reasoning` 四级回落推断：网关 `supports_reasoning` 声明层三态 → `reasoning_effort_levels`（档位存在即推理）→ `supported_openai_params` 含 `reasoning_effort`/`thinking` → 名字前缀正则 `REASONING_MODEL_PATTERN` 兜底
- 思考档位自动推导 + 菜单精确对齐（v0.10.1 起）：网关 `model_info` 的 `reasoning_effort_levels`（完整档集，同名多 deployment 取交集，未知档名忽略）或 `supports_{xhigh,max}_reasoning_effort` 布尔可精确声明档位——**有档位时菜单与档集精确对齐**：档集内的档直传自身 effort（选什么发什么），档集外的默认档以 `null` 从菜单显式排除，网关 `none` 档即 off（不含则 `off:null`——不发 disabled，对强制思考后端会 4xx，显式 off 请求 clamp 最低档）；**无档位（或同名组交集为空）**维持 `{ max: "max" }` 兜底（全菜单可选）。`forceAdaptiveThinking` 对全部推理模型保留（effort 传递通道：budget 路径无法表达档位枚举）。设计取舍见 `docs/adr/0001`
- 未登录或拉取失败时回退该实例的持久化目录 ?? 静态兜底目录

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

## 验证行为说明

- 未登录时 `pi --list-models` **不会显示**本 provider 的模型——Pi 只列出已通过认证检查的 provider 的模型（`getAvailable` 按 auth 过滤），这是 Pi 的设计，不是扩展缺陷
- 未登录直接 `--model my-gateway/<id>` 会报 `No API key found for my-gateway. Use /login`，即证明 provider 注册成功；多实例可分别用 `--model <instance-id>/<model-id>` 做同样验证
- 完整验证顺序：`/login` → `/model` → 发消息 → 模型出现在列表

## 环境要求

- Pi ≥ 0.81.0（0.84.x 捆绑的 undici 需要 Node ≥ 22；系统默认 node 为 20 时需用 node@22 wrapper 启动 pi）
- omp（oh-my-pi）≥ 17.0（以 `#!/usr/bin/env bun` 脚本分发，需 Bun；内置 legacy 插件兼容 shim 自动把 `@earendil-works/pi-*` 导入重写到 `@oh-my-pi/pi-*`）
- 网络可达 Keycloak 与 LiteLLM 网关

## 双运行时兼容（pi / omp）

pi 与 omp 都以 legacy `OAuthLoginCallbacks` 调用扩展的 `oauth.login(callbacks)`，但构造的回调对象有差异：

| 回调 | pi（adaptOAuth 适配器） | omp（legacy 兼容适配器） |
|---|---|---|
| `onDeviceCode` | 提供（原生设备码对话框） | **缺失** |
| `onAuth` | 提供 | 提供（渲染登录对话框，含 Ctrl+click URL） |
| `onPrompt` / `onProgress` | 提供 | 提供 |
| `onSelect` / `onManualCodeInput` | 提供 | 缺失 |

Device Flow 设备码展示按运行时传入的回调能力**三级探测**，一套代码同时适配当前两套运行时并前瞻未来：

1. `onDeviceCode` —— pi 的 `adaptOAuth` 适配器完整提供，走原生设备码对话框
2. `onAuth` —— omp 的 legacy 回调省略了 `onDeviceCode`，回退到 `onAuth`：以 verificationUri 为可点击 URL、userCode 写入 instructions，omp 的 LoginDialog 渲染等价登录对话框
3. `notify({type:"device_code"})` —— 新 `AuthInteraction` 通道（pi-ai 内置 provider 已用此形状；扩展通道未来若切换，此处自动生效，无需发版）

`refreshToken` / `getApiKey` 两套运行时签名一致，无需适配。

### Session / Customer header 注入限制

`before_provider_headers` 钩子（注入 `x-litellm-trace-id` 与 `x-litellm-customer-id`）**仅在 pi 上生效**。omp 没有 `before_provider_headers` 事件，只有 `before_provider_request`——后者操作的是 API 请求体（`payload`：model/messages/tools/metadata），不含 HTTP headers，返回值也只能替换 payload。omp 的 `ProviderConfig.headers` 是静态 `Record<string,string>`，不支持动态回调。因此 omp 侧的网关请求不携带 session/customer header，网关侧 SpendLogs 无法按 session 聚合或按 customer 归因 omp 发出的请求。钩子在 omp 中注册安全（`on()` 不校验事件名，存入 handlers map 但永不触发），不影响其他功能。

> **成本跟踪不受此限制**：成本可观测性用 `after_provider_response` + `message_end`（omp 两者皆有），故 pi 与 omp 上均生效。

## 已知限制

- Keycloak access token 默认 5 分钟有效期，刷新完全依赖 Pi 的 5 分钟缓冲窗口；offline refresh token 失效后 Pi 提示重新 `/login`
- `reasoning` 四级回落推断依赖网关声明，稀疏模型仍靠名字正则；非 thinking 模型若被误判可调整 `extension/models.ts` 的 `REASONING_MODEL_PATTERN`，或修正网关 `supports_reasoning` / `supported_openai_params` 配置
- 思考档位：菜单精确对齐依赖网关 `model_info` 配置 `reasoning_effort_levels`（未配的模型走 `{max:"max"}` 兜底全菜单）；网关误配会直接反映到用户菜单（网关声明权威，不在客户端修补）；`forceAdaptiveThinking` 对部分后端未实测，最坏情况后端不思考但不报错；xhigh 仅在网关声明 `supports_xhigh_reasoning_effort` 或 levels 含 xhigh 时可选。若某后端拒绝 adaptive thinking 格式，该模型 thinking 请求会报错，可在 `extension/models.ts` 的 `ADAPTIVE_THINKING` 按模型名豁免
- LiteLLM 网关需暴露 Anthropic 协议端点（`/v1/messages`）且 JWT claims 含 `preferred_username`/`email`（`litellm_jwtauth` 字段映射）
- **omp 限制**：`before_provider_headers` 钩子在 omp 中不触发，session/customer header 注入仅 pi 生效；omp 上成本显示为 $0.00 通常意味着网关把该请求路由到免费/别名后端并上报 0 成本（LiteLLM 在值为 0 时省略裸 `x-litellm-response-cost` 头），非零展示需部署侧返回非零成本

## 开发

```bash
# 构建（bundle + minify 产出 dist/index.js；npm install 时 prepare 也会自动构建）
npm install --no-audit --no-fund
npm run build

# 测试（bun 原生跑 .ts，零依赖；pi-* 为 import type 被 transpile 擦除）
bun test        # 或 npm test

# 发布物结构不变量检查（CI verify/publish 同款，需先 build）
npm run supply-chain:guard

# 类型检查（机器无关写法，详见 CLAUDE.md 开发流程）
npm install --no-save typescript@5 @types/node@22
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_ROOT/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
./node_modules/.bin/tsc -p tsconfig.json
rm -rf node_modules
```

**构建产物即发布物**：`extension/` 的 TS 源码经 esbuild 打包为单文件 minified `dist/index.js`（`pi.extensions` 指向它）。dist 不进仓库，构建发生在两条路径：**npm 发布**由 GitHub Actions（`.github/workflows/ci.yml`，仅 `v*` tag 触发）构建后 `npm publish --provenance`；**git 源安装**在本机经 `prepare` 钩子构建（devDeps 未装时 fallback 临时装 pinned esbuild）。TS 源码不进 npm tarball（`files` 仅含 `dist`）。esbuild 仅为 devDependency，运行时仍零依赖。

> v0.5.0 起由“源码即发布物”改为 bundle 分发，目的是避免客户端直接阅读/修改源码导致网关侧 header 注入等行为被篡改。这只是提高门槛，无法对抗有意绕过（git 源安装路径拿到的仍是完整源码）。

**发布管线完整性**（CI 强制）：

- publish job 发布前断言 tag == `package.json` version == `package-lock.json` version，杜绝打错 tag 静默发布错版
- `scripts/supply-chain-guard.mjs`（verify/publish 均执行）强制五类不变量：禁安装期脚本（`preinstall`/`install`/`postinstall`；`prepare` 例外——git 源安装的生命线）、零运行时依赖、禁非 registry 依赖 spec（`git:`/`file:`/`link:` 等）、lockfile `resolved` 域名白名单（仅 registry.npmjs.org）、npm pack 文件白名单精确到文件名（仅 `LICENSE`/`README.md`/`dist/index.js`/`package.json`）
- CI 装依赖用 `npm ci --ignore-scripts`（`prepare` 被跳过，构建统一走显式 `npm run build`）；发布带 npm provenance（OIDC 签名，需仓库 secret `NPM_TOKEN`）

这些机制防的是**发布管线与依赖供应链**（恶意依赖、安装期脚本、非 registry 来源、版本漂移），与客户端防篡改（minify 提高门槛）是两个互补的威胁面。

## License

[MIT](./LICENSE)
