# pi-provider-litellm-oidc

> 英文版：[README.md](README.md)

Pi coding agent 通过 Keycloak OIDC 免密钥（keyless）接入 LiteLLM 网关的 provider 扩展：经 Device Authorization Flow（RFC 8628）取得 JWT，以 `Authorization: Bearer` 调用网关的 Anthropic 协议端点 `/v1/messages`，全程无静态 API Key。一套代码同时适配 [pi](https://github.com/earendil-works/pi) 与 omp（oh-my-pi）。

扩展不自带任何部署默认值：网关地址、Keycloak realm 与 client 都由部署方提供——环境变量用于单实例，JSON 配置文件用于同一 pi / omp 进程内的多实例接入。

## 能力清单

- **免密钥 OIDC 登录**：Keycloak Device Authorization Flow（RFC 8628）并支持 PKCE（S256）；不保存静态 API Key，JWT 以 `Authorization: Bearer` 发往网关的 Anthropic 协议端点
- **认证生命周期交给框架**：凭据持久化、过期前 5 分钟自动刷新、refresh token 轮换与并发锁均由 Pi 管理，扩展只实现三个 OAuth 回调
- **单进程多网关**：环境变量定义单实例，或 JSON `instances[]` 定义多个独立 provider，各自拥有凭据、目录与登录命名空间
- **网关驱动的模型目录**：从 `/model/info` 拉取并按 provider 持久化，支持实例级静态兜底；推理能力、视觉、token 上限与 per-token 成本均由网关元数据推断，稀疏模型回落到名字正则
- **思考档位对齐**：pi 思考菜单与网关声明的档位精确对齐（含 `none` ↔ `off`、`max`），并走 adaptive thinking 使所选 effort 真正送达后端
- **网关侧花费归因**：注入 session 标识（`x-litellm-trace-id`）与 customer 标识（`x-litellm-customer-id`，取自 JWT email claim），并以模型级兜底通道覆盖绕过会话钩子的调用
- **客户端每轮成本**：把网关 `x-litellm-response-cost` 摊入 `message.usage.cost`，pi 与 omp 都能显示真实每轮成本
- **非 chat 模态**：网关上部署的图像生成/编辑与结构化决策自动成为 pi 的 image/classifier 模型，可经 codemode 调用
- **双运行时**：一套代码同时适配 pi 与 omp，设备码展示按回调能力三级探测（pi 对话框 → omp LoginDialog → 未来 AuthInteraction）
- **供应链加固**：零运行时依赖、单文件 minified 产物、npm provenance 发布，以及 CI 对发布管线的结构校验

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

### git 源

```bash
pi install git:git@github.com:jesset/pi-provider-litellm-oidc.git
```

### 本地目录(开发)

```bash
git clone https://github.com/jesset/pi-provider-litellm-oidc.git
cd pi-provider-litellm-oidc
npm install --no-audit --no-fund   # prepare 会构建 dist/index.js
```

已运行中的 Pi 会话用 `/reload` 热加载。

### Keycloak 侧前置要求

- 公共客户端，启用 OAuth 2.0 Device Authorization Grant
- **PKCE（v0.9.1 起）**：device 授权请求携带 `code_challenge`（S256）、token 轮询携带 `code_verifier`（RFC 7636）。Keycloak 26 起 admin console 对 public client 默认强制 PKCE（client 属性 `pkceCodeChallengeMethod=S256`）——扩展已实现该基线，无需在服务端关闭；旧版 Keycloak 忽略这些参数。报 `Missing parameter: code_challenge_method` 说明用的是更早版本，升级即可
- Client scope 含 `offline_access`（长时 refresh token 的必要条件）
- LiteLLM 网关 `JWT_PUBLIC_KEY_URL` 指向该 realm 的 JWKS，`enable_jwt_auth: true`

## 文档

- [配置参考](docs/configuration.zh-cn.md)——标识注入、成本跟踪、模型列表策略与非 chat 模态（[English](docs/configuration.md)）
- [设计决策](docs/adr/)——思考档位对齐与多实例配置的 ADR
- [领域术语表](CONTEXT.md)
- [开发指引](CLAUDE.md)
- [变更日志](CHANGELOG.md)

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

标识注入、成本跟踪、模型列表策略与非 chat 模态的细节见[配置参考](docs/configuration.zh-cn.md)。

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
npm install --no-audit --no-fund   # 安装 devDependencies；prepare 会构建一次
npm run build                      # bundle + minify 产出 dist/index.js
npm run typecheck                  # 按钉死版本的 pi 类型包跑 tsc
bun test                           # 单元测试（bun 原生跑 .ts）
npm run docs:check                 # 校验文档相对链接可达
npm run supply-chain:guard         # 发布物结构不变量检查（需先 build）
```

以上六步在 CI 中同样全部执行。TypeScript、`@types/node` 与 pi 类型包（钉死版本）均为 devDependencies，干净 clone 无需全局安装 pi 即可类型检查。

**构建产物即发布物**：`extension/` 的 TS 源码经 esbuild 打包为单文件 minified `dist/index.js`（`pi.extensions` 指向它）。dist 不进仓库，构建发生在两条路径：**npm 发布**由 `Publish` workflow（`.github/workflows/publish.yml`，GitHub Release 触发或手动输入 tag 触发）构建后 `npm publish --provenance`；**git 源安装**在本机经 `prepare` 钩子构建（devDeps 未装时 fallback 临时装 pinned esbuild）。TS 源码不进 npm tarball（`files` 仅含 `dist`）。esbuild 仅为 devDependency，运行时仍零依赖。

> v0.5.0 起由“源码即发布物”改为 bundle 分发，目的是避免客户端直接阅读/修改源码导致网关侧 header 注入等行为被篡改。这只是提高门槛，无法对抗有意绕过（git 源安装路径拿到的仍是完整源码）。

**发布管线完整性**（CI 强制）：

- publish job 发布前断言 tag == `package.json` version == `package-lock.json` version，并校验 checkout 的提交就是该 tag 指向的提交，杜绝打错 tag 静默发布错版
- `scripts/supply-chain-guard.mjs`（verify/publish 均执行）强制五类不变量：禁安装期脚本（`preinstall`/`install`/`postinstall`；`prepare` 例外——git 源安装的生命线）、零运行时依赖、禁非 registry 依赖 spec（`git:`/`file:`/`link:` 等）、lockfile `resolved` 域名白名单（仅 registry.npmjs.org）、npm pack 文件白名单精确到文件名（仅 `LICENSE`/`README.md`/`README.zh-cn.md`/`dist/index.js`/`package.json`）
- 发布使用 **npm trusted publishing**（OIDC），仓库中不保存任何 token secret；在 npmjs.com 上一次性配置 trusted publisher（仓库 + `publish.yml`）即可

这些机制防的是**发布管线与依赖供应链**（恶意依赖、安装期脚本、非 registry 来源、版本漂移），与客户端防篡改（minify 提高门槛）是两个互补的威胁面。

## License

[MIT](./LICENSE)
