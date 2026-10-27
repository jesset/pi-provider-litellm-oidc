# pi-provider-litellm-oidc

Pi coding agent 通过 Keycloak OIDC 免配置（keyless）接入 LiteLLM 网关的 provider 扩展，无需任何静态 API Key。一套代码同时适配 pi 与 omp（oh-my-pi）。

内嵌 LiteLLM 默认值开箱即用；环境变量用于单实例部署，JSON 配置文件用于同一 pi / omp 进程内的多实例接入。

## 架构

```
pi agent
  │
  │ /login <provider> ──→ oauth.login(callbacks)
  │    1. POST {keycloak}/realms/{realm}/protocol/openid-connect/auth/device
  │       (公共客户端, scope="openid profile email offline_access")
  │    2. 展示设备码——按回调能力三级探测：
  │       onDeviceCode() → pi 原生设备码对话框
  │       onAuth()       → omp LoginDialog（verificationUri + userCode）
  │       notify()       → 未来 AuthInteraction 通道（自动生效）
  │    3. 轮询 token endpoint（grant_type=urn:ietf:params:oauth:grant-type:device_code）
  │    4. 返回 {access, refresh, expires}，Pi 持久化到 ~/.pi/agent/auth.json
  │
  │ 请求时（Pi 框架管理）：
  │    - access token 临过期（5min 窗口）→ oauth.refreshToken() → Keycloak refresh_token grant
  │    - authHeader: true → Authorization: Bearer <JWT>
  ▼
LiteLLM 网关 (enable_jwt_auth + JWKS 指向 Keycloak，网关侧零改动)
  └─ /v1/messages（api: "anthropic-messages"）
```

## 安装

### 方式 A：pi install（推荐）

```bash
# 一行快速安装（registry 公开，匿名即可；环境变量名含 : 故需 env 包装）
env npm_config_registry=https://registry.npmjs.org/ \
  pi install npm:pi-provider-litellm-oidc

# 或持久配置 ~/.npmrc（实例级 endpoint，scope 路由只影响 @public 前缀包，
# 对 tech 组下所有 @public/* 包通用；私有部署时需第二行 token）
#   registry=https://registry.npmjs.org/
#   //registry.npmjs.org/:_authToken=<个人访问令牌(read_api)>
echo registry=https://registry.npmjs.org/ >> ~/.npmrc
pi install npm:pi-provider-litellm-oidc

# git 源（注意 scp 简写必须带 git@，否则 Pi 会当作本地路径）
pi install git:git@github.com/jesset/pi-provider-litellm-oidc.git@v0.5.1

# 本地路径（开发/单机）
cd pi-provider-litellm-oidc && ./install.sh
```

> git 源安装会在本机 clone 完整源码并经 `prepare` 钩子现场构建 dist（需 Node ≥ 22 与外网可达 npmjs 拉 esbuild）——拿到的是源码，防篡改保护只存在于 npm 通道；对普通用户推荐 npm 方式。

已运行中的 Pi 会话用 `/reload` 热加载。

### 方式 B：omp install（oh-my-pi）

```bash
# omp 同样支持 pi install 语法（omp 内置 pi 兼容的插件加载器）
env npm_config_registry=https://registry.npmjs.org/ \
  omp install npm:pi-provider-litellm-oidc
```

> omp（oh-my-pi）是 pi 的 compiled binary 发行版，内置 legacy 插件兼容 shim，
> 自动把 `@earendil-works/pi-*` 导入重写为其内置 `@oh-my-pi/pi-*` 包。本扩展
> 已适配两套运行时的 OAuth 回调差异（见下文"双运行时兼容"）。

### Keycloak 侧前置要求

- 公共客户端，启用 OAuth 2.0 Device Authorization Grant
- **PKCE（0.9.1 起）**：扩展的 device 授权请求携带 `code_challenge`（S256）、token
  轮询携带 `code_verifier`（RFC 7636）。Keycloak 26 起 admin console 对 public client
  默认强制 PKCE（client 属性 `pkceCodeChallengeMethod=S256`）——扩展已实现该基线，
  无需在服务端关闭；旧版 Keycloak 忽略这些参数，向后兼容。报
  `Missing parameter: code_challenge_method` 说明用 0.9.1 之前的扩展，升级即可
- Client scope 含 `offline_access`（长时 refresh token 的必要条件）
- LiteLLM 网关 `JWT_PUBLIC_KEY_URL` 指向该 realm 的 JWKS，`enable_jwt_auth: true`

## 使用

```text
/login litellm              # Keycloak Device Flow 登录（任意设备浏览器完成验证）
/model litellm/kimi-k2.7-code
/logout litellm             # 清除凭据
/session-header              # 查看各实例登录状态与 session / customer 注入
```

## 配置

### 单实例：环境变量（legacy）

未发现配置文件时，使用环境变量定义一个实例；未设置任何变量时使用 LiteLLM 默认值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_OIDC_PROVIDER_ID` | `litellm` | 单实例 Pi provider ID（`/login`、`--model` 的前缀） |
| `LITELLM_OIDC_DISPLAY_NAME` | `LiteLLM Gateway` | UI 显示名 |
| `LITELLM_OIDC_GATEWAY_URL` | `https://litellm.example.com` | LiteLLM 网关地址 |
| `LITELLM_OIDC_KEYCLOAK_URL` | `https://keycloak.example.com` | Keycloak 根地址 |
| `LITELLM_OIDC_KEYCLOAK_REALM` | `Example` | realm 名 |
| `LITELLM_OIDC_KEYCLOAK_CLIENT_ID` | `coding-agent-cli` | OAuth 公共客户端 ID |
| `LITELLM_OIDC_KEYCLOAK_SCOPE` | `openid profile email offline_access` | OIDC scope |

> **升级注意（v0.4.0 起）**：环境变量前缀已由 `LEGACY_*` 一刀切换为 `LITELLM_OIDC_*`（变量名属于扩展而非具体部署，与仓库名对齐；LiteLLM 仅保留为默认回退值）。若 shell profile 或 `~/.pi/agent/settings.json` 的 `env` 块中写有旧变量，需同步改名；未设置任何变量的用户无感，默认值行为不变。

环境变量写法：`~/.pi/agent/settings.json` 的 `env` 块、shell profile、或启动时 `LITELLM_OIDC_...=... pi`。

> **HTTPS 强制（v0.10.0 起）**：环境变量的 `LITELLM_OIDC_GATEWAY_URL` / `LITELLM_OIDC_KEYCLOAK_URL`，以及配置文件的 `gatewayUrl` / `keycloakUrl` 必须使用 `https://`——误配 `http://` 会让 JWT 与 refresh token 明文过线，扩展在加载时直接报错（fail-fast）；唯一例外是 loopback 主机（`localhost` / `127.x` / `[::1]`，本地调试代理）。
>
> **refresh 瞬态失败 backoff（v0.10.0 起）**：Keycloak 瞬断/限流时，Pi credential lock 后排队的刷新调用会形成惊群（每次都再打 token endpoint）。扩展按实例与 refresh token 记录 5s backoff 窗口，窗口内直接返回未过期的旧凭据；仅瞬态异常（网络/解析层）记录 backoff，OAuth 语义错误（如 `invalid_grant`）照常抛出强制重新 `/login`，旧 token 已过期时不 backoff（立即重试）。

### 多实例：JSON 配置文件

配置文件可在一个 pi / omp 进程中注册多个独立 provider。每个实例拥有自己的网关、Keycloak、凭据和模型目录；文件存在时，`instances[]` **完全取代** `LITELLM_OIDC_*` 实例变量，不做合并。

发现顺序：

1. `LITELLM_OIDC_CONFIG=/path/to/litellm-oidc.json`（相对路径按当前工作目录解析）；
2. `$PI_CODING_AGENT_DIR/litellm-oidc.json`；
3. 运行时默认路径：pi 为 `~/.pi/agent/litellm-oidc.json`；omp 按 `PI_CONFIG_DIR` 与 `OMP_PROFILE` / `PI_PROFILE` 推导，默认为 `~/.omp/agent/litellm-oidc.json`；
4. 均未发现时回退到环境变量单实例。

显式路径不存在、JSON 非法或任一实例字段错误都会使扩展加载失败，不会静默回退。修改文件后执行 `/reload` 生效。

```json
{
  "instances": [
    {
      "id": "litellm",
      "name": "LiteLLM Gateway",
      "gatewayUrl": "https://litellm.example.com",
      "keycloakUrl": "https://keycloak.example.com",
      "realm": "Example",
      "clientId": "coding-agent-cli"
    },
    {
      "id": "staging",
      "name": "Staging Gateway",
      "gatewayUrl": "https://gateway.ai.example.com",
      "keycloakUrl": "https://keycloak.example.com",
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
  ]
}
```

实例必填字段：`id`、`name`、`gatewayUrl`、`keycloakUrl`、`realm`、`clientId`。`scope` 默认 `openid profile email offline_access`，`modelInfoPath` 默认 `/model/info`。`id` 必须全局唯一、使用小写字母/数字开头且不能含 `/`，也不能覆盖 pi / omp 内置 provider。

文件实例的 `fallbackModels` 默认空数组，**不会继承 LiteLLM 内置 11 模型**。网关 `/model/info` 不可用时，如需离线静态目录，必须按完整 `ProviderModelConfig` 显式声明；legacy 环境变量单实例仍保留内置目录。顶层还可选 `session`、`customer`、`cost` 块，用于覆盖对应的全局环境变量；实例内仅 `customer` 可继续覆盖，`session` 与 `cost` 保持全局。

## Session / Customer 标识注入（网关聚合与用户归因）

`before_provider_headers` 钩子给**已注册实例**的 LLM 请求注入两类标识，其他 provider 的请求不受影响：

1. **Session 标识**（Pi 会话 UUID）：把同一会话的多次请求（工具调用循环、重试、多 turn）聚合到同一 session。不影响机器上其他 provider 的请求。

默认 header `x-litellm-trace-id` 是 LiteLLM proxy 原生解析链中优先级最高的会话/追踪头（`x-litellm-trace-id` > `x-litellm-session-id` > 任意 `x-<vendor>-session-id`），值会写入 `LiteLLM_SpendLogs.session_id` 列并同步 metadata 的 `trace_id`/`session_id`，Session Logs UI 按它分组，还会向嵌套 MCP/A2A 调用传播；网关侧零配置。注意：早期默认 `x-session-id` 不匹配 LiteLLM 的 `^x-.+-session-id$` 通用正则（缺 vendor 段），会被网关完全忽略，故弃用。

2. **Customer 标识**（用户 email）：默认 header `x-litellm-customer-id`，这是 LiteLLM proxy 的标准 customer/end-user 头（网关零配置即解析），值写入 SpendLogs 的 customer 维度；配合网关侧 `user_header_mappings`（映射用户属性）与 `extra_spend_tag_headers`（自动打 spend tag）可按用户 email 建用户、聚合个人用量。值直接取自框架已写入最终请求头的 `Authorization: Bearer <token>`（与实际发送的 token 严格同源，大小写不敏感解析），本地 base64url 解 JWT payload 取 `email` claim，不验签（同一 token 本就作为 bearer 发往网关，只是镜像一个 claim）；token 非 JWT、claim 缺失或未登录时跳过注入，不影响请求。

   Customer 头走**双通道**保证覆盖所有调用路径：
   - **会话主循环**（工具调用、多 turn、重试）经 `before_provider_headers` 钩子注入；
   - **模型级呑底**：`oauth.modifyModels` 在框架每次取模型目录时用当前 credential 把 customer 头写进每个 model.headers，这样**绕过会话钩子**的调用（如 `pi-observational-memory` 的观察/反思/压缩用裸 `pi-ai/compat` streamSimple 直接调 LLM）经 pi-ai createClient 合并 `model.headers` 也同样携带。session 头仍只走钩子通道（session id 是会话级概念，不属于模型）。落盘的 models-store 只存原始目录、不含用户标识。

   > 排错提示：网关 SpendLogs 里那些 session_id 是随机 uuid、且单请求的“神秘 session”，多来自这类绕过钩子的后台调用（OM 压缩、第三方 SDK 客户端等无 trace 头，LiteLLM 会自动生成 uuid 作 session_id）；本扩展的 customer 头现已覆盖到 OM 这类调用，但无 trace 头的请求仍不会有真实会话关联。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_CUSTOMER_HEADER` | `x-litellm-customer-id` | customer 标识 header 名；显式设为空字符串可禁用注入 |
| `LITELLM_CUSTOMER_CLAIM` | `email` | 依次尝试的 JWT claim 名，逗号分隔可配回退链，如 `email,preferred_username` |

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_SESSION_HEADER` | `x-litellm-trace-id` | session 标识 header 名；显式设为空字符串可禁用注入 |
| `LITELLM_SESSION_PREFIX` | （空） | 可选前缀，例如 `pi-`；LiteLLM 要求值为 `^[a-zA-Z0-9_-]{8,}$`，前缀含 `.`/`:` 等字符会使 header 被网关丢弃 |
| `LITELLM_SESSION_CLIENT_HEADER` | （空） | 可选第二个 header 名（值固定 `pi`），用于网关侧客户端归因；不设置则不发送 |

行为要点：

- 重试复用相同 headers，钩子不会重复触发，session id 保持一致
- 多实例时，同一 session id 会发往各实例网关；A、B 两个网关各自形成独立的 SpendLogs 分组，不表示存在跨网关共享的会话存储
- `/fork`、`/clone` 生成新 session 文件与新 UUID（合理语义）；子代理与主会话共享同一 id
- `/new` 或 pi 重启后 id 变化；`pi -c` / `--session` 恢复会话保持原 id
- 上述 header 解析链于 2026-03 上游合入（PR #22626 起），网关版本较旧时 header 不被解析（注入无害但无聚合效果），需网关侧重升级；`x-litellm-customer-id`/`x-litellm-end-user-id` 为标准 customer 头，官方文档标注"always checked without any configuration"，解析不依赖该新版本链

> 迁移自全局扩展 `~/.pi/agent/extensions/session-id-header.ts`（原 `PI_SESSION_*` 变量）：合并后请删除旧全局扩展，避免双重注入；配置变量已改为 `LITELLM_SESSION_*`。若网关侧已按旧 header 名 `x-session-id` 建立了聚合逻辑，可设 `LITELLM_SESSION_HEADER=x-session-id` 保持旧行为。

## 成本 / 用量可观测性

移植自 balcsida `src/cost.ts`。网关在 `/v1/messages`（anthropic-messages 腿）响应头返回 `x-litellm-response-cost`（单次请求总成本）；扩展经两个钩子把它变成客户端可见的每轮成本：

- `after_provider_response`：读该头存入按 provider 隔离的 pending slot（无成本头的响应清 slot，防跨请求残留串扰）
- `message_end`：取 pending 总成本，按 input/output/cacheRead/cacheWrite token 比例摊到 `message.usage.cost`，返回替换消息——pi 与 omp 的每轮成本展示（omp 自带 $X.XX 渲染）均读 `usage.cost`

**pi + omp 均生效**：成本跟踪只用 `after_provider_response` + `message_end`，omp 两者皆有；不用 omp 缺的 `before_provider_headers`，因此与 session/customer 注入不同，omp 上也工作。与 session/customer 正交：后者是网关侧 spend 维度（session_id/customer_id），前者是客户端侧单次成本值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_COST_TRACKING` | （启用） | 是否启用成本跟踪；显式设为空字符串可禁用 |
| `LITELLM_COST_HEADER` | `x-litellm-response-cost` | 读取的响应头名；默认折扣后实付，可设 `x-litellm-response-cost-original` 取折扣前标价 |

## 模型列表策略

- 启动时注册静态兜底目录：legacy 环境变量单实例为内置 11 个常用 chat 模型；配置文件实例使用各自的 `fallbackModels`（缺省为空）
- 网络刷新成功的目录经 `context.publish({ persist })` 持久化到 `~/.pi/agent/models-store.json`，之后离线启动直接恢复真实目录，不再请求网关
- `refreshModels` 遵守框架两阶段刷新协议：`allowNetwork=false`（扩展注册、每次 refresh 的 phase 1）零网络请求；网络阶段从 `context.credential` 取已刷新的 access token 调 `/model/info`（尊重框架 abort signal 与本地 15s 超时）
- 数据源用 `/model/info` 而非 `/v1/models`：前者返回 deployment 级 DB 实配值（token limits、`supports_vision`、mode），后者的这些字段来自 LiteLLM 静态 cost map 按公开模型名查找——自研/别名模型（如 `kimi-k2.7-code`）一律缺失，会被误滤掉。要求网关把 `/model/info` 列入 `public_routes`（用户 JWT 可访问）
- 过滤规则：剔除 `mode` 显式为 embedding/rerank/image_generation 的条目（mode 缺失是自研模型常态，不据此排除）；隐藏 `staging/` 前缀（网关内部命名空间）与 `-openai` 后缀（OpenAI 协议腿孪生，与 anthropic 腿重复）的内部条目；同名多 deployment 聚合为一条（token 上限等标量字段取首个非空值，成本字段取 max 保守上界）
- 能力聚合 all-true（v0.10.0 起）：LiteLLM 同名组按 deployment 轮询，`supports_vision` 需全部 deployment 显式支持才宣传（未声明当不支持——轮到不支持的后端发图会 500）；`supports_reasoning` 任一显式 false 一票否决、全部显式 true 才直出、未声明混合回落兜底链。`input` 按 vision 判定决定是否含 image
- `model.cost` 从 `/model/info` 的 4 个 per-token 成本字段实配（`input`/`output`/`cache_read_input`/`cache_creation`，多 deployment 取 max 上界，缺失保持 0）——请求前估算与 `x-litellm-response-cost` 实付口径互补
- `reasoning` 四级回落推断：网关 `supports_reasoning` 声明层三态 → `reasoning_effort_levels`（档位存在即推理）→ `supported_openai_params` 含 `reasoning_effort`/`thinking` → 名字前缀正则 `REASONING_MODEL_PATTERN` 兜底（覆盖稀疏模型）
- 思考档位自动推导 + 菜单精确对齐（v0.10.1 起）：网关 `model_info` 的 `reasoning_effort_levels`（完整档集，同名多 deployment 取交集，未知档名忽略）或 `supports_{xhigh,max}_reasoning_effort` 布尔可精确声明档位——**有档位时菜单与档集精确对齐**：档集内的档直传自身 effort（选什么发什么），档集外的默认档以 `null` 从菜单显式排除，网关 `none` 档即 off（不含则 `off:null`——不发 disabled，对强制思考后端会 4xx，显式 off 请求 clamp 最低档）；**无档位（或同名组交集为空）**维持 `{ max: "max" }` 兜底（v0.8.0 行为，全菜单可选）。`forceAdaptiveThinking` 对全部推理模型保留（effort 传递通道：budget 路径无法表达档位枚举）。实测 glm-5.2 max 比 high 多约 70% 思考量。LiteLLM 网关已配档位字段（2026-09-27 探针）：glm-5.3 系 / k3 系 / claude 系（`['low','high','max']`）菜单为 low/high/max 三档；deepseek-flash（`['none','low','high','max']`）菜单为 off/low/high/max；设计决策见 `docs/adr/0001`
- 未登录或拉取失败时回退该实例的持久化目录 ?? 静态兜底目录

## 验证行为说明

- 未登录时 `pi --list-models` **不会显示**本 provider 的模型——Pi 只列出已通过认证检查的 provider 的模型（`getAvailable` 按 auth 过滤），这是 Pi 的设计，不是扩展缺陷
- 未登录直接 `--model litellm/<id>` 会报 "No API key found for litellm. Use /login"，即证明 provider 注册成功
- 完整验证顺序：`/login` → `/model` → 发消息 → 模型出现在列表

## 环境要求

- Pi ≥ 0.81.0（0.84.x 捆绑的 undici 需要 Node ≥ 22；系统默认 node 为 20 时需用 node@22 wrapper 启动 pi）
- omp（oh-my-pi）≥ 17.0（compiled binary，无外部 Node 依赖；内置 legacy 插件兼容 shim 自动重写 `@earendil-works/pi-*` 导入到 `@oh-my-pi/pi-*`）
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

1. `onDeviceCode` —— pi 的 `adaptOAuth` 适配器完整提供，走原生设备码对话框（pi 行为不变）
2. `onAuth` —— omp 的 legacy 回调省略了 `onDeviceCode`，回退到 `onAuth`：以 verificationUri 为可点击 URL、userCode 写入 instructions，omp 的 LoginDialog 渲染等价登录对话框
3. `notify({type:"device_code"})` —— 新 `AuthInteraction` 通道（pi-ai 内置 provider 已用此形状；扩展通道未来若切换，此处自动生效，无需发版）

这修复了 omp 下 `/login` 报 `e.onDeviceCode is not a function` 的问题。三分支已对真实 Keycloak 端到端验证（各取真实 device code 确认路由正确）。`refreshToken` / `getApiKey` 两套运行时签名一致，无需适配。

### Session / Customer header 注入限制

`before_provider_headers` 钩子（注入 `x-litellm-trace-id` session 标识与 `x-litellm-customer-id` customer 标识）**仅在 pi 上生效**。omp 没有 `before_provider_headers` 事件（strings 验证：0 匹配），只有 `before_provider_request`——后者操作的是 API 请求体（`payload`：model/messages/tools/metadata），不含 HTTP headers，返回值也只能替换 payload。omp 的 `ProviderConfig.headers` 是静态 `Record<string,string>`，不支持动态回调。因此 omp 侧的网关请求不携带 session/customer header，网关侧 SpendLogs 无法按 session 聚合或按 customer 归因 omp 发出的请求。钩子在 omp 中注册安全（`on()` 不校验事件名，存入 handlers map 但永不触发），不影响其他功能。待 omp 暴露 header 注入能力后可启用。

> **成本跟踪不受此限制**：成本可观测性用 `after_provider_response` + `message_end`（omp 两者皆有），不用 `before_provider_headers`，故 pi 与 omp 上均生效。

## 已知限制

- Keycloak access token 默认 5 分钟有效期，刷新完全依赖 Pi 的 5 分钟缓冲窗口；offline refresh token 失效后 Pi 提示重新 `/login`
- `reasoning` 四级回落推断（声明层三态 → `reasoning_effort_levels` → `supported_openai_params` → 名字正则），稀疏模型仍靠名字正则，非 thinking 模型若被误判可调整 models.ts 的 `REASONING_MODEL_PATTERN` 或查网关 `supports_reasoning`/`supported_openai_params` 配置
- 思考档位：菜单精确对齐依赖网关 `model_info` 配置 `reasoning_effort_levels`（未配的模型走 `{max:"max"}` 兜底全菜单）；网关误配会直接反映到用户菜单（网关声明权威，不在客户端修补）；`forceAdaptiveThinking` 对 deepseek-v4-flash / glm-5.3 / zai/glm-4.7 等后端未实测（限流/权限），最坏情况后端不思考但不报错；xhigh 不可选（litellm 后端不支持，网关未声明）。若某后端拒绝 adaptive thinking 格式，该模型 thinking 请求会报错，可在 models.ts 的 `ADAPTIVE_THINKING` 按模型名豁免
- LiteLLM 网关需暴露 Anthropic 协议端点（`/v1/messages`）且 JWT claims 含 `preferred_username`/`email`（`litellm_jwtauth` 字段映射）
- **omp 限制**：`before_provider_headers` 钩子在 omp 中不触发（omp 无此事件），session/customer header 注入仅 pi 生效；成本跟踪不受此限（用 omp 也有的两个 hook，pi/omp 均生效，已端到端探针确认）。omp 上成本显示为 $0.00 是 LiteLLM 网关侧行为：对 coding-agent CLI 请求路由到免费别名后端（如 `claude-sonnet-5`→`glm-5.3`@智谱），网关上报成本为 0；非零展示需部署侧返回非零成本

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

**构建产物即发布物**：`extension/` 的 TS 源码经 esbuild 打包为单文件 minified `dist/index.js`（`pi.extensions` 指向它）。dist 不进仓库，构建发生在两条路径：**npm 发布**由 CI（`.gitlab-ci.yml`，仅 `v*` tag 触发）构建后 `npm publish` 到 GitLab 组级 npm registry（`@public` scope）；**git 源安装**在本机经 `prepare` 钩子构建（devDeps 未装时 fallback 临时装 pinned esbuild）。TS 源码不进 npm tarball（`files` 仅含 `dist`）。esbuild 仅为 devDependency，运行时仍零依赖。

> 此前（≤ v0.4.1）为"源码即发布物"（Pi 原生加载 .ts）；v0.5.0 起改为 bundle 分发，目的是避免客户端直接阅读/修改源码导致网关侧 header 注入等行为被篡改。注意这只是提高门槛，无法对抗有意绕过（git 源安装路径拿到的仍是完整源码）。

**发布管线完整性**（CI 强制，移植自 balcsida 的裁剪版，调研见 `docs/wayfinder/research/08-balcsida-packaging-tamper.md`）：

- publish job 发布前断言 tag == `package.json` version == `package-lock.json` version，杜绝打错 tag 静默发布错版
- `scripts/supply-chain-guard.mjs`（verify/publish 均执行）强制五类不变量：禁安装期脚本（`preinstall`/`install`/`postinstall`；`prepare` 例外——git 源安装的生命线）、零运行时依赖、禁非 registry 依赖 spec（`git:`/`file:`/`link:` 等）、lockfile `resolved` 域名白名单（registry.npmjs.org + github.com/jesset）、npm pack 文件白名单精确到文件名（仅 `LICENSE`/`README.md`/`dist/index.js`/`package.json`）
- CI 装依赖用 `npm ci --ignore-scripts`（`prepare` 被跳过，构建统一走显式 `npm run build`）；CI 镜像 pin 到次版本 `node:22.23`

这些机制防的是**发布管线与依赖供应链**（恶意依赖、安装期脚本、非 registry 来源、版本漂移），与客户端防篡改（minify 提高门槛）是两个互补的威胁面。
