# CLAUDE.md

本仓库的 Claude Code / pi 工作指引。领域术语见 `CONTEXT.md`，设计取舍见 `docs/adr/`。

## 项目概述

pi-provider-litellm-oidc：pi coding agent 的 keyless OIDC provider 扩展。通过 Keycloak Device Authorization Flow（RFC 8628，含 PKCE）获取 JWT，以 `Authorization: Bearer` 调用 LiteLLM 网关的 Anthropic 协议端点 `/v1/messages`，全程无静态 API Key。同时适配 pi 与 omp（oh-my-pi）两套运行时。

**扩展不内置任何部署默认值**：网关地址、realm、client、provider ID 与静态模型目录全部由部署方提供。

## 关键设计决策

- **构建产物即发布物**：`extension/*.ts` 经 esbuild bundle + minify 为单文件 `dist/index.js`（`build.mjs`，`npm run build`），`pi.extensions` 指向它，`files` 仅含 `dist`——TS 源码不进 npm tarball。`dist/` 不进仓库：npm 发布由 GitHub Actions 在 `v*` tag 上构建后 `npm publish --provenance`；git 源安装在本机经 `prepare` 钩子构建（pi 的 git 安装执行 `npm install --omit=dev`，prepare 以 `--include=dev` 显式覆盖 `npm_config_omit=dev` 临时装 pinned esbuild）。目的是避免客户端修改源码篡改 header 注入等行为（仅提高门槛——git 源安装拿到的仍是完整源码）
- **零运行时依赖**：Device Flow / refresh 只用标准 `fetch` + `URLSearchParams`；esbuild 仅为 devDependency。pi 内置包（`@earendil-works/pi-ai`、`pi-coding-agent`）为 optional peerDependencies，esbuild 以 external 处理（只有类型导入，值导入会构建失败）
- **配置两种载体**：未发现配置文件时，`LITELLM_OIDC_*` 定义单个实例（必需变量缺失即 fail-fast）；多实例使用 JSON `instances[]`，发现顺序为显式 `LITELLM_OIDC_CONFIG` > `$PI_CODING_AGENT_DIR/litellm-oidc.json` > 运行时默认（pi `~/.pi/agent`；omp 按 `PI_CONFIG_DIR`/profile 推导，默认 `~/.omp/agent`）。文件存在时完全取代 env 实例配置。`extension/config.ts` 统一归一化为 `InstanceConfig[]`，每个实例独立注册 provider。严格 schema 校验：未知字段、必填缺失、重复/非法 provider ID、pi+omp 内置 registry 冲突、非 HTTPS URL 均加载期失败
- **认证生命周期交给框架**：凭据持久化、过期前 5 分钟自动 `refreshToken`、并发锁都由 Pi 管理；扩展只实现 `login` / `refreshToken` / `getApiKey`，不自建缓存或定时器。Keycloak refresh token 轮换返回的新 refresh token 必须完整回传（`toCredentials`），漏存会导致下次刷新失败
- **refresh 瞬态失败 backoff**：`refreshAccessToken` 按实例 + refresh token keyed 记 5s backoff 窗口，避免 Keycloak 瞬断时的刷新惊群；仅 transient 异常记录，OAuth 语义错误（如 `invalid_grant`）照抛强制重登，旧 token 已过期不 backoff
- **HTTPS 强制**：`assertSecureUrl` 校验网关/Keycloak/模型级 baseUrl 为 https（loopback 例外），防 JWT 与 refresh token 明文过线
- **模型目录三层策略**：静态兜底（各实例 `fallbackModels`，缺省为空）+ 网络刷新（`/model/info`，需网关列入 `public_routes`）+ `context.publish({ persist })` 持久化恢复。`refreshModels` 严格遵守两阶段协议：`allowNetwork=false` 绝不打网络。**不用 `/v1/models`**：其 mode/max_tokens 来自 LiteLLM 静态 cost map 按公开名查找，自研/别名模型一律缺失，`/model/info` 才是 deployment 级 DB 实配值。abort 用 `AbortSignal.any([context.signal, 本地 15s 超时])`
- **过滤与聚合**：剔除 mode 显式为 embedding/rerank/audio_*/video/realtime/batch/ocr 的条目（mode 缺失不排除）；隐藏 `-openai` 后缀（OpenAI 协议腿孪生）；同名多 deployment 聚合（标量取首个非空、成本取 max 上界）。能力聚合 all-true：vision 需全部 deployment 显式 true，reasoning 任一显式 false 一票否决
- **思考档位**：`getSupportedThinkingLevels` 对 `xhigh`/`max` 要求 `thinkingLevelMap` 显式声明，且 `mapped === null` 是通用菜单排除机制。`resolveEffortLevels` 读网关 `reasoning_effort_levels`（同名组取交集）或 `supports_{xhigh,max}_reasoning_effort`：有档位 → 菜单精确对齐（档集内直传自身 effort，档集外默认档以 `null` 排除，网关 `none` 即 off；交集为空视同未声明）；无档位 → `{ max: "max" }` 档位兜底。`compat.forceAdaptiveThinking` 对全部推理模型保留——effort 只能经 adaptive 分支的 `output_config.effort` 传递，budget 路径无法表达档位枚举
- **session / customer 标识注入**（仅 pi）：`before_provider_headers` 按 `ctx.model.provider` 过滤，只对已注册实例注入 `x-litellm-trace-id`（会话聚合，写入 SpendLogs.session_id）与 `x-litellm-customer-id`（用户归因）。customer 值从最终请求头的 `Authorization: Bearer` 解 JWT claim（不验签，只镜像同一 token 的 claim）。**customer 头双通道**：`oauth.modifyModels` 把 header stamp 进 `model.headers`，覆盖绕过会话钩子的裸 `streamSimple` 调用；session 头只走钩子（会话级概念不属于模型）
- **成本可观测性**（pi + omp）：`after_provider_response` 存 `x-litellm-response-cost` 到按 provider 隔离的 pending slot（无成本头清 slot），`message_end` 按 token 比例摊入 `message.usage.cost`。纯函数 `parseResponseCost` / `attributeCost`
- **非 chat 模态**：`/model/info` 的 mode 数据驱动分流——`image_generation`/`image_edit` → pi `type:"image"`；`decisions`/`evaluation` → `type:"classifier"`。两个 API 实现必须经 `ProviderConfig` 显式注册：`litellm-images`（`/v1/images/generations` JSON 或 `/v1/images/edits` multipart）与 `litellm-decisions`（System One wire `/v1/systemone`，bool↔noul）。认证用框架注入的 `options.apiKey`，customer 头经 model.headers stamp 生效，session 头不注入。错误不 throw，返回带 `stopReason: error` 的结果形状
- **双运行时兼容**：pi 与 omp 都以 legacy `OAuthLoginCallbacks` 调用 `oauth.login`，但 omp 的回调对象缺 `onDeviceCode`/`onSelect`。设备码展示按能力三级探测：`onDeviceCode` → `onAuth`（verificationUri 作 URL、userCode 写入 instructions）→ `notify({type:"device_code"})`。用 `typeof === "function"` 运行时探测，不依赖框架类型声明

## 开发流程

```bash
npm install --no-audit --no-fund   # 装 esbuild，prepare 自动构建一次
npm run build                      # bundle + minify → dist/index.js
bun test                           # 单元测试（bun 原生跑 .ts，零依赖）
npm run supply-chain:guard         # 发布物结构不变量检查（需先 build）

# 类型检查（机器无关：npm root -g 自动解析 npm/nvm/Homebrew 全局路径）
npm install --no-save typescript@5 @types/node@22
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_ROOT/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
./node_modules/.bin/tsc -p tsconfig.json
rm -rf node_modules
```

顺序不能颠倒：先 `npm install` 再建软链（避免 npm 清理软链）；`--no-save` 不改 package.json。tsc/bun 均非运行时依赖（Pi 经 jiti 原生加载 .ts，transpile-only 不做类型检查）。

- Git 规范：Conventional Commits；功能分支 `feat/<kebab-case>`；合并到 main 前更新 CHANGELOG
- 变更行为时同步更新 README.md、CONTEXT.md（术语）、docs/adr（决策）与本文件

## 验证要点

- 认证：Device Flow 走通（设备码出现）、对话正常、5 分钟后二次对话（JWT 自动刷新无感）
- 模型目录：交互启动触发网络刷新后 `~/.pi/agent/models-store.json` 更新，`pi --list-models` 数量一致，抽一个新模型实际对话
- 思考档位：选网关声明了档位的模型，菜单与档集一致；选 max 确认产生 thinking 块
- session/customer：`/session-header` 输出正确；网关 SpendLogs 按 session 聚合、按 customer 归因；非本 provider 请求不受影响
- 模态：codemode `models.getModelOfType("image"/"classifier")` 端到端可用
- 改配置 schema 后：显式路径失败不回落、文件取代 env、多实例目录与凭据隔离

## Pi 平台已知行为

- 未登录时 `pi --list-models` 不显示本 provider 的模型（`getAvailable` 按认证状态过滤）；直接 `--model <provider>/<id>` 报 "No API key found" 即证明注册成功
- Pi 0.84.x 捆绑的 undici 需要 Node ≥ 22
- `git:` 简写必须带 `git@`（`git:git@host:path.git@ref`），否则被当作本地路径
- `registerProvider` 在扩展加载阶段被 queue，runner 绑定后统一 flush；加载后立即生效，无需 `/reload`
- omp 是 Bun 单文件可执行程序，内置 `@oh-my-pi/pi-*` 框架；omp 无 `before_provider_headers`、无 `onDeviceCode`/`onSelect`，`ProviderConfig.headers` 为静态对象。钩子在 omp 中注册安全但不触发
- `ProviderConfig.headers` 与 `compat` 的 schema 归框架所有，扩展只做浅层校验，不能写死字段白名单

## 发布

1. 更新 `package.json` / `package-lock.json` 版本与 CHANGELOG（Keep a Changelog 格式）
2. 本地 `npm run build && bun test && npm run supply-chain:guard`
3. 打 tag `vX.Y.Z` 并推送；CI 的 publish job 校验 tag 与两处版本一致后以 `--provenance` 发布（需仓库 secret `NPM_TOKEN`）

`scripts/supply-chain-guard.mjs` 强制：禁安装期脚本（`prepare` 例外）、零运行时依赖、禁非 registry 依赖 spec、lockfile `resolved` 仅 registry.npmjs.org、npm pack 文件白名单精确到文件名。
