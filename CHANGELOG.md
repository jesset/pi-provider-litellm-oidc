# Changelog

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵守 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.4.1] - 2026-08-17

### 变更

- 模型目录数据源由 `/v1/models` 切换为 `/model/info`（需网关将其列入 `public_routes`）：前者的 mode/max_tokens 来自 LiteLLM 静态 cost map 按公开名查找，自研/别名模型（如 `kimi-k2.7-code`）一律缺失，`mode=chat` 白名单误滤了网关上 34 个模型中的 24 个（含实际可对话模型）；后者返回 deployment 级 DB 实配值
- 过滤规则改为 mode 黑名单（embedding/rerank/image_generation）+ 隐藏 `staging/` 与 `-openai` 内部条目；同名多 deployment 聚合；`input` 按 `supports_vision` 判定（未声明按纯文本，避免向非多模态后端发图 500）
- fallback 静态列表参数按网关 DB 实配校准（claude 系输出上限 128000→131072、kimi-k2.7-code contextWindow 262144→200000、sonnet 系标明图片支持、其余非多模态模型移除 image）
- `reasoning` 前缀匹配补充 `kimi/`、`k3`、`llm-` 形式

### 修复

- README：reasoning 模型前缀列表补充 `zai\/glm-`，与 models.ts 的 `REASONING_MODEL_PATTERN` 对齐

## [0.4.0] - 2026-08-16

### 变更

- **BREAKING**：环境变量前缀由 `LEGACY_*` 一刀切换为 `LITELLM_OIDC_*`（7 个连接配置变量），无兼容双读；未设置任何变量的用户无感，LiteLLM 保留为默认回退值

## [0.3.2] - 2026-08-16

### 修复

- 遵守 pi 运行时契约：模型刷新两阶段协议（`allowNetwork=false` 零网络）、请求头注入（`before_provider_headers`）、Device Flow 错误按 OAuth 语义分类（slow_down 退避、access_denied/expired_token 立即失败）

## [0.3.1] - 2026-08-16

### 新增

- 注入 `x-litellm-customer-id` header：从当前 access token（JWT）的 email claim 解出用户标识，供网关按用户维度归因 spend；`LITELLM_CUSTOMER_*` 变量可配 header 名与 claim 回退链

### 修复

- 类型检查开发流程改为机器无关写法（自动解析 npm/nvm/Homebrew 全局路径，不再依赖 bun）

## [0.3.0] - 2026-08-16

### 变更

- session 标识默认 header 由 `x-session-id` 切换为 `x-litellm-trace-id`（LiteLLM 原生解析链最高优先头，写入 SpendLogs.session_id；旧值不匹配网关 `^x-.+-session-id$` 正则会被忽略）。可通过 `LITELLM_SESSION_HEADER` 恢复旧行为

## [0.2.0] - 2026-08-16

### 新增

- 注入稳定 session 标识 header（Pi 会话 UUID），把同一会话的多次请求聚合到 LiteLLM SpendLogs 同一 session；`LITELLM_SESSION_*` 变量可配 header 名、前缀与客户端归因头

## [0.1.0] - 2026-08-16

### 新增

- Keycloak Device Authorization Flow（RFC 8628）登录，全程无静态 API Key
- 以 `Authorization: Bearer` 调用 LiteLLM 网关 Anthropic 协议端点 `/v1/messages`
- 认证生命周期（凭据持久化、临过期自动刷新、并发锁）交给 Pi 框架管理
- 模型列表三层策略：静态 fallback + `/v1/models` 网络刷新 + models-store.json 离线恢复
- 全部部署参数经环境变量覆盖，LiteLLM 默认值开箱即用
- `/session-header` 命令查看注入配置与当前 session id

[Unreleased]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jesset/pi-provider-litellm-oidc/-/releases/v0.1.0
