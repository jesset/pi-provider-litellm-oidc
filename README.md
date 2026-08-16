# pi-provider-litellm-oidc

Pi coding agent 通过 Keycloak OIDC 免配置（keyless）接入 LiteLLM 网关的 provider 扩展，无需任何静态 API Key。

内嵌 LiteLLM 默认值开箱即用；全部部署参数可通过环境变量覆盖，支持多套 Keycloak + LiteLLM 网关实例并存。

## 架构

```
pi agent
  │
  │ /login <provider> ──→ oauth.login(callbacks)
  │    1. POST {keycloak}/realms/{realm}/protocol/openid-connect/auth/device
  │       (公共客户端, scope="openid profile email offline_access")
  │    2. callbacks.onDeviceCode() ← Pi 原生展示设备码与验证 URL
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
# git 源（本仓库；注意 scp 简写必须带 git@，否则 Pi 会当作本地路径）
pi install git:git@github.com/jesset/pi-provider-litellm-oidc.git@v0.1.0

# npm 源（发布到内网 registry 后）
pi install npm:pi-provider-litellm-oidc

# 本地路径（开发/单机）
cd pi-provider-litellm-oidc && ./install.sh
```

已运行中的 Pi 会话用 `/reload` 热加载。

### Keycloak 侧前置要求

- 公共客户端，启用 OAuth 2.0 Device Authorization Grant
- Client scope 含 `offline_access`（长时 refresh token 的必要条件）
- LiteLLM 网关 `JWT_PUBLIC_KEY_URL` 指向该 realm 的 JWKS，`enable_jwt_auth: true`

## 使用

```text
/login litellm              # Keycloak Device Flow 登录（任意设备浏览器完成验证）
/model litellm/kimi-k2.7-code
/logout litellm             # 清除凭据
/session-header              # 查看 session 标识注入配置与当前 session id
```

## 通用化配置（环境变量）

未设置任何变量时使用 LiteLLM 默认值。接入另一套 Keycloak + LiteLLM 实例：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LEGACY_PROVIDER_ID` | `litellm` | Pi provider ID（`/login`、`--model` 的前缀）；改它即可多实例并存 |
| `LEGACY_DISPLAY_NAME` | `LiteLLM Gateway` | UI 显示名 |
| `LEGACY_GATEWAY_URL` | `https://litellm.example.com` | LiteLLM 网关地址 |
| `LEGACY_KEYCLOAK_URL` | `https://keycloak.example.com` | Keycloak 根地址 |
| `LEGACY_KEYCLOAK_REALM` | `Example` | realm 名 |
| `LEGACY_KEYCLOAK_CLIENT_ID` | `coding-agent-cli` | OAuth 公共客户端 ID |
| `LEGACY_KEYCLOAK_SCOPE` | `openid profile email offline_access` | OIDC scope |

环境变量写法：`~/.pi/agent/settings.json` 的 `env` 块、shell profile、或启动时 `LEGACY_...=... pi`。

### 多实例示例

为另一套环境（如 staging 网关）同时注册第二个 provider：

```bash
LEGACY_PROVIDER_ID=staging-gateway \
LEGACY_DISPLAY_NAME="Staging Gateway" \
LEGACY_GATEWAY_URL=https://gateway.ai.example.com \
LEGACY_KEYCLOAK_URL=https://keycloak.example.com:443 \
LEGACY_KEYCLOAK_REALM=staging \
pi
# 之后 /login staging-gateway 与 /login litellm 互不影响
```

> 注意：变量在扩展加载时读取。同一进程内改环境变量需 `/reload`；两套实例并存需要两个 pi 进程或两份扩展副本（改 `LEGACY_PROVIDER_ID` 拷贝目录）。单进程多实例的配置文件化（JSON per-instance）是后续演进方向。

## Session 标识注入（网关聚合）

`before_provider_headers` 钩子给**仅本 provider** 的 LLM 请求注入稳定 session 标识（Pi 会话 UUID），便于 LiteLLM 网关侧把同一会话的多次请求（工具调用循环、重试、多 turn）聚合到同一 session。不影响机器上其他 provider 的请求。

默认 header `x-litellm-trace-id` 是 LiteLLM proxy 原生解析链中优先级最高的会话/追踪头（`x-litellm-trace-id` > `x-litellm-session-id` > 任意 `x-<vendor>-session-id`），值会写入 `LiteLLM_SpendLogs.session_id` 列并同步 metadata 的 `trace_id`/`session_id`，Session Logs UI 按它分组，还会向嵌套 MCP/A2A 调用传播；网关侧零配置。注意：早期默认 `x-session-id` 不匹配 LiteLLM 的 `^x-.+-session-id$` 通用正则（缺 vendor 段），会被网关完全忽略，故弃用。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LITELLM_SESSION_HEADER` | `x-litellm-trace-id` | 注入的 header 名；显式设为空字符串可禁用注入 |
| `LITELLM_SESSION_PREFIX` | （空） | 可选前缀，例如 `pi-`；LiteLLM 要求值为 `^[a-zA-Z0-9_-]{8,}$`，前缀含 `.`/`:` 等字符会使 header 被网关丢弃 |
| `LITELLM_SESSION_CLIENT_HEADER` | （空） | 可选第二个 header 名（值固定 `pi`），用于网关侧客户端归因；不设置则不发送 |

行为要点：

- 重试复用相同 headers，钩子不会重复触发，session id 保持一致
- `/fork`、`/clone` 生成新 session 文件与新 UUID（合理语义）；子代理与主会话共享同一 id
- `/new` 或 pi 重启后 id 变化；`pi -c` / `--session` 恢复会话保持原 id
- 上述 header 解析链于 2026-03 上游合入（PR #22626 起），网关版本较旧时 header 不被解析（注入无害但无聚合效果），需网关侧重升级

> 迁移自全局扩展 `~/.pi/agent/extensions/session-id-header.ts`（原 `PI_SESSION_*` 变量）：合并后请删除旧全局扩展，避免双重注入；配置变量已改为 `LITELLM_SESSION_*`。若网关侧已按旧 header 名 `x-session-id` 建立了聚合逻辑，可设 `LITELLM_SESSION_HEADER=x-session-id` 保持旧行为。

## 模型列表策略

- 启动时注册静态 fallback 列表（10 个常用 chat 模型）
- `refreshModels` 从 `context.credential` 取已刷新的 access token 调 `/v1/models`，过滤 `mode=chat`、剔除 `-openai` 后缀与 `staging/` 前缀项（这些走 OpenAI 协议腿，anthropic-messages api 调不通）
- 未登录或拉取失败时回退 fallback 列表

## 验证行为说明

- 未登录时 `pi --list-models` **不会显示**本 provider 的模型——Pi 只列出已通过认证检查的 provider 的模型（`getAvailable` 按 auth 过滤），这是 Pi 的设计，不是扩展缺陷
- 未登录直接 `--model litellm/<id>` 会报 "No API key found for litellm. Use /login"，即证明 provider 注册成功
- 完整验证顺序：`/login` → `/model` → 发消息 → 模型出现在列表

## 环境要求

- Pi ≥ 0.81.0（0.84.x 捆绑的 undici 需要 Node ≥ 22；系统默认 node 为 20 时需用 node@22 wrapper 启动 pi）
- 网络可达 Keycloak 与 LiteLLM 网关

## 已知限制

- Keycloak access token 默认 5 分钟有效期，刷新完全依赖 Pi 的 5 分钟缓冲窗口；offline refresh token 失效后 Pi 提示重新 `/login`
- `reasoning: true` 按模型名前缀推断（claude-/kimi-/glm-/deepseek-），非 thinking 模型若被误判可调整 models.ts 的 `REASONING_MODEL_PATTERN`
- LiteLLM 网关需暴露 Anthropic 协议端点（`/v1/messages`）且 JWT claims 含 `preferred_username`/`email`（`litellm_jwtauth` 字段映射）

## 开发

```bash
# 类型检查（需 peer 依赖可解析，本地软链或 npm install 后）
bunx tsc -p tsconfig.json
```

源码即发布物（Pi 原生加载 .ts，无需构建步骤）。
