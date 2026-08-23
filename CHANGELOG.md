# Changelog

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵守 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.3] - 2026-08-23

### 修复

- 兼容 omp（oh-my-pi，compiled binary）并前瞻未来 AuthInteraction 通道：Device Flow 设备码展示改为按运行时传入的回调能力三级探测——优先 `onDeviceCode`（pi 的 adaptOAuth 适配器完整提供，走原生设备码对话框），缺失时回退 `onAuth`（omp 的 legacy 回调省略了 `onDeviceCode`，以 verificationUri 为可点击 URL、userCode 写入 instructions，omp 的 LoginDialog 渲染等价登录对话框），再缺失时用 `notify({type:"device_code"})`（新 AuthInteraction 通道，pi-ai 内置 provider 已用此形状；扩展通道未来若切换，此处自动生效，无需发版）。修复 omp 下 `/login` 报 `e.onDeviceCode is not a function`。三分支已对真实 Keycloak 端到端验证

### 已知限制

- omp 无 `before_provider_headers` 事件（只有 `before_provider_request`，操作 API 请求体而非 HTTP headers），session/customer header 注入（`x-litellm-trace-id` / `x-litellm-customer-id`）仅在 pi 上生效；omp 请求不携带这些 header，网关侧无法按 session 聚合或按 customer 归因。钩子在 omp 中注册安全但不触发，待 omp 暴露 header 注入能力后可启用

## [0.5.2] - 2026-08-19

### 变更

- README 安装节补 `echo registry=... >> ~/.npmrc` 一行式持久配置写法

## [0.5.1] - 2026-08-19

### 修复

- `prepare` 钩子由"先失败再兜底"（第一跳 `node build.mjs` 在无 devDeps 时必打 `ERR_MODULE_NOT_FOUND` 堆栈，吓到用户）改为"先探测再构建"（`test -d node_modules/esbuild || npm install ... ; node build.mjs`）——git 源安装与开发安装两条路径均单次构建、无报错输出；CI 发布（`npm ci` 已装 devDeps）同样跳过兜底

## [0.5.0] - 2026-08-19

### 变更

- **BREAKING（发布形态）**：发布物由 TS 源码改为 esbuild bundle + minify 的单文件 `dist/index.js`（`pi.extensions` 指向它；`extension/` 源码不再进 npm tarball）。目的：避免客户端直接阅读/修改源码导致网关侧 session/customer header 注入被篡改。注意这只是提高篡改门槛，无法对抗有意绕过（git 源安装路径拿到的仍是完整源码）
- **BREAKING（包名）**：改为 `pi-provider-litellm-oidc`（GitLab 组级 npm registry 分发要求 scope 匹配根命名空间；用户 `.npmrc` 只需 `registry` 一行，不影响其他包的默认 registry）
- 新增 `.gitlab-ci.yml`：verify job（push/MR 构建 + 语法冒烟）；publish job 仅 `v*` tag 触发，以 CI_JOB_TOKEN 发布到组级 endpoint `npm registry`（后发布者胜出，属可接受行为）
- `dist/` 不进仓库：npm 发布由 CI 构建后 publish；git 源安装经 `prepare` 钩子在本机构建（fallback 以 `--include=dev` 显式覆盖 npm 传入的 `npm_config_omit=dev` 临时装 pinned esbuild，实测 pi git 安装 `npm install --omit=dev` 场景下可用）
- 开发流程相应调整：`npm install` 时 prepare 自动构建；类型检查步骤不变，详见 README 开发节

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

[0.5.3]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jesset/pi-provider-litellm-oidc/-/releases/v0.1.0
