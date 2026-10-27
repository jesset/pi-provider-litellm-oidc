# Changelog

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵守 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **单进程多 LiteLLM OIDC 实例**：新增 JSON `instances[]` 配置，单份扩展可在 pi / omp 中注册多个独立 provider，各自使用独立的网关、Keycloak、Device Flow、凭据与模型目录。文件发现顺序为显式 `LITELLM_OIDC_CONFIG` > `$PI_CODING_AGENT_DIR/litellm-oidc.json` > 运行时默认路径；文件存在时完全取代 `LITELLM_OIDC_*` 实例配置，无文件时保持 legacy 单实例行为
- **严格配置校验与实例级静态目录**：未知字段、必填缺失、重复/非法/内置冲突 provider ID、非 HTTPS URL 均在加载时 fail-fast；文件实例可声明完整 `ProviderModelConfig` 的 `fallbackModels`，缺省为空且不继承 LiteLLM 内置目录；实例可覆盖 customer header 与 JWT claim 链
- `/session-header` 汇总配置来源以及各实例的登录状态、session / customer 注入结果；新增 ADR `docs/adr/0002-multi-instance-config-file.md`

### 变更

- 配置由模块级单例改为统一归一化的 `InstanceConfig[]`；Keycloak 登录/刷新与模型目录请求显式接收实例配置，refresh transient backoff 按实例 + refresh token 隔离
- `session` 与成本跟踪保持全局，成本 pending slot 继续按 provider 隔离；文件顶层的 `session` / `customer` / `cost` 可覆盖对应全局环境变量

### 测试

- `bun test` 119 个用例：覆盖文件发现与优先级、legacy 兼容、严格 schema、完整 fallbackModels、多实例 Device Flow、请求头与成本分发、`/session-header` 汇总
- 严格 `tsc`、esbuild 构建与 supply-chain guard 通过；真实 pi / omp 在隔离 agent 目录中完成双 provider 注册冒烟验证

## [0.10.1] - 2026-09-27

### 修复

- **思考菜单与网关档位声明精确对齐**（ADR `docs/adr/0001`）：网关 `reasoning_effort_levels` 已声明时，thinkingLevelMap 成为档集的镜像——档集内的档声明为自身值（选什么发什么 effort，minimal 直传，不再走 pi 序列化 switch 的 minimal→low 近似）；档集外的默认可选档（off/minimal/low/medium/high）以 `null` 显式排除（pi 的 `mapped === null` 是通用菜单排除机制，非 off 专属）；网关 `none` 档即 pi 的 off（含则 `off:"off"` 可选，不含则 `off:null`）；未知档名忽略（LiteLLM 对未知 level 同样丢弃）。此前档集外的 minimal/medium 仍出现在菜单（0.10.0 已知缝隙）。v0.8.0 的 off-null 黑洞陷阱仅在无据盲目补全时成立，档集声明正是依据
- **同名组档位交集为空视同未声明**：回落 `{max}` 兜底。修复 0.10.0 的边界缺陷——档位声明过但交集为空且 reasoning 经名字正则判 true 时会产出 `{off:null}`，菜单只剩 off、连 max 都消失
- 新增域文档：`CONTEXT.md`（术语表）与 `docs/adr/0001`（本决策），同时补上 CLAUDE.md 对二者的既有引用

### 修复（代码审查后续）

- **布尔拼装级读 `supports_none_reasoning_effort`**（opt-in：`true` 才含 none）：此前布尔级产出的档集恒不含 none，落到对齐逻辑后 off 恒为 null——部署仅配布尔且 `supports_none=true` 时 off 被误排除。不照搬 LiteLLM 对 none 的 opt-out 默认含：对强制思考后端错误宣称支持关思考会 4xx，宁缺勿滥；levels 声明才是 wins whole 的权威
- **levels 全为未知档名时视同未声明**：fall-through 到布尔拼装级，不再提前返回跳过回落链第二级
- 七档知识收敛为单一 `THINKING_LEVEL_TABLE` 对照表（pi↔gateway↔edge），`KNOWN_EFFORT_LEVELS` / `DEFAULT_THINKING_LEVELS` / `EDGE_THINKING_LEVELS` 全部从表派生
- 注释修正：interface 布尔注释按 v0.10.1 语义改写（不再"none 不读"）、ADAPTIVE_THINKING 的 off 红线表述精化为"兜底路径省略，有据声明见 ADR 0001"、"hack 兜底"统一为术语表规范词"档位兜底"

### 测试

- `bun test` 92 个用例（+5）：minimal 直传与档集不含 low 不外溢、未知档忽略/全未知回落兜底、交集为空回落兜底、布尔级读 none（off:"off"）、全未知 fall-through；改写 6 个档位用例为精确对齐断言
- 真实数据 dry-run（66 deployment）：glm/k3/claude 系 12 模型菜单 `[low,high,max]`，deepseek-flash `[off,low,high,max]`，档集内档 effort 全部直传自身值

## [0.10.0] - 2026-09-27

吸收自 downstream fork（v0.11.0/v0.12.0 的三项演进，代码逻辑原样吸收，组织特定部署设定不吸收；该 fork 为本仓库 v0.9.1 的快照分支，git 历史独立故手工搬运）。

### 新增

- **refresh 瞬态失败 backoff**（吸收 312efab，演进自 balcsida v3.1.0）：Keycloak 瞬断/限流时，pi credential lock 后排队的刷新调用会形成惊群（每次都再打一次 token endpoint）。`refreshAccessToken` 按 refresh token keyed 记 5s backoff 窗口，窗口内直接返回未过期的旧 credentials；仅 transient（fetch/JSON 解析层异常）记录 backoff，OAuth 语义错误（`invalid_grant` 等 4xx）照抛强制重新 `/login`，旧 token 已过期时不 backoff（立即重试）。签名改为收整个 credentials
- **网关/Keycloak URL HTTPS 强制**（吸收 312efab）：`assertSecureUrl` 在模块加载时 fail-fast 校验 `LITELLM_OIDC_GATEWAY_URL` / `LITELLM_OIDC_KEYCLOAK_URL` 必须为 https——误配 http 会明文发送 JWT 与 refresh token；loopback 主机（localhost/127.x/[::1]）例外供本地调试
- **`model.cost` 从 `/model/info` 实配**（吸收 da59d55）：读取 4 个 per-token 成本字段（input/output/cache_read_input/cache_creation），同名多 deployment 按字段取 max 保守上界，缺失保持 0——请求前估算与 `x-litellm-response-cost` 实付口径互补。LiteLLM 探针（2026-09-27）：58/66 deployment 有值，吸收即刻生效
- **思考档位自动推导**（吸收 1658746 + fffdaa3）：`reasoning_effort_levels`（网关完整档集，同名多 deployment 取交集）为回落链第一级，`supports_{xhigh,max}_reasoning_effort` per-level 布尔拼装为第二级，原三级链（`supports_reasoning` 声明层三态 > `supported_openai_params` > 名字正则）后移成四级。thinkingLevelMap 来源分化：有精确档位从 levels 生成 edge 声明（xhigh/max 值=effort 直传，minimal~high 走 pi 默认拼写），且 levels 不含 `none` 档（后端强制思考，发 disabled 会 4xx）时有据声明 `off:null`（菜单移除 off、不发送 disabled、显式 off 请求 clamp 到最低档）——v0.8.0 的 off-null 黑洞陷阱仅在无据盲目补全时成立；无档位声明维持 `{max:"max"}` hack 兜底。`forceAdaptiveThinking` 对全部推理模型保留（effort 传递通道）。LiteLLM 探针（2026-09-27 二次）：52/66 deployment 已配 `reasoning_effort_levels: ['low','high','max']`（无 none 档），档位推导即时激活——12 个模型（glm-5.3 系 / k3 系 / claude 系）thinkingLevelMap 变为 `{max:"max", off:null}`（off 从菜单移除，网关声明强制思考），4 个未声明档位模型维持 `{max}` 兜底；dry-run 验证 reasoning/vision 判定零变化

### 变更

- **能力聚合 any→all**（吸收 da59d55）：`supports_vision` 需全部同名 deployment 显式 true 才宣传（LiteLLM 同名组轮询，任一后端不支持发图会 500，未声明当不支持）；`supports_reasoning` 三态聚合（任一显式 false 一票否决、全部显式 true 才直出、未声明混合回落兜底）——修复此前"先见 false 后见 true 被锁死 false"的聚合边界。LiteLLM 现网无混合声明同名组，判定零变化（dry-run 验证）

### 测试

- `bun test` 87 个用例（+34）：新增 test/config.test.ts（HTTPS 校验）、test/refresh-backoff.test.ts（backoff 全边界），models.test.ts 扩展 all-true 聚合与档位推导用例

## [0.9.1] - 2026-09-19

### 修复

- **Device Flow 补齐 PKCE（RFC 7636，S256；吸收自 downstream fork 0.10.1 同款实现）**：Keycloak 26
  起 admin console 对 public client 默认将 PKCE method 设为 S256（client 属性
  `pkceCodeChallengeMethod`，Capability config 的 "PKCE method"），device 授权端点对
  enforced client 校验 code_challenge——不发送 PKCE 参数的实现报 `Keycloak device
  authorization failed: Missing parameter: code_challenge_method`（DeviceEndpoint.
  handleDeviceRequest → AuthorizationEndpointChecker.checkPKCEParams）。现 device
  授权请求携带 code_challenge（S256），token 轮询携带 code_verifier；每个登录会话独立
  verifier，窃取 device_code 无法单独兑换 token。OAuth 2.1 对 public client 全 grant
  强制 PKCE，属正确安全基线，**不应在服务端关闭该校验**。旧版 Keycloak 忽略这些参数
  （2026-09-19 对 LiteLLM 实测：带 PKCE 参数的 device 授权请求返回 200 + device_code）。
  refresh grant 不涉及 PKCE，不变

### 测试

- 新增 `test/pkce.test.ts`（+4）：S256 派生用 RFC 7636 Appendix B 官方测试向量锁定，
  verifier 格式（43 字符 unreserved）与高熵唯一性

## [0.9.0] - 2026-08-24

### 新增

- **发布供应链守护**（`scripts/supply-chain-guard.mjs`，`npm run supply-chain:guard`，CI verify/publish 均执行；移植自 balcsida 的裁剪版，调研见 `docs/wayfinder/research/08-balcsida-packaging-tamper.md`）：禁安装期脚本（`preinstall`/`install`/`postinstall`；`prepare` 保留——git 源安装的生命线）、零运行时依赖从约定升级为 CI 强制、禁非 registry 依赖 spec（`git:`/`file:`/`link:` 等）、lockfile `resolved` 域名白名单（registry.npmjs.org + github.com/jesset）、npm pack 文件白名单精确到文件名（仅 `LICENSE`/`README.md`/`dist/index.js`/`package.json`）
- **发布前版本一致性断言**：publish job 先校验 tag == `package.json` version == `package-lock.json` version，杜绝打错 tag 静默发布错版

### 变更

- CI 装依赖改用 `npm ci --ignore-scripts`（verify/publish），`prepare` 被跳过，构建统一走显式 `npm run build`（esbuild 平台二进制经 optionalDependencies 安装不受影响，已实测）；CI 镜像 `node:22` pin 到次版本 `node:22.23`
- 调研笔记：balcsida/pi-provider-litellm 打包分发与防篡改机制（`docs/wayfinder/research/08`）——其"防篡改"实指发布管线完整性，客户端本地篡改防护为零（dist 不 minify，弱于本项目）

## [0.8.0] - 2026-08-24

### 新增

- **max 思考级别**：litellm 全部推理模型附加 `thinkingLevelMap: { max: "max" }` + `compat: { forceAdaptiveThinking: true }`（models.ts 常量 `ADAPTIVE_THINKING`，transformModelInfo 与 FALLBACK_MODELS 两处 spread）。网关 `/model/info` 不返回 thinking 级别映射（`supports_*_reasoning_effort` 全 NULL，研究 04），而 pi 的 `getSupportedThinkingLevels` 对 `max` 要求 `thinkingLevelMap` 显式声明——故此前 UI 缺 max。`forceAdaptiveThinking` 让 anthropic-messages 腿走 adaptive 分支，effort=max 经 `output_config.effort` 传给网关（否则 budget-based 把 max clamp 到 high，max 沦为摆设）。xhigh 不声明（litellm 后端不支持，pi-ai 内置 zai/kimi catalog 亦无）。实测（2026-08-24）glm-5.2 adaptive+effort=max 比 high 多约 70% 思考量（679 vs 395 字符）；k3 / kimi-k2.7-code / kimi/k3 / claude-sonnet-5 同样接受 adaptive+max。副作用：low/medium/high 从 budget-based 改为 effort-based（与 kimi/k3 官方 anthropic 腿配置一致，实测全部正常）
- **测试**：`bun test` 53 个用例（+7），覆盖推理/非推理模型的 `thinkingLevelMap` 与 `forceAdaptiveThinking` 注入、fallback 模型一致性

### 文档

- CLAUDE.md / README 记录 max 思考级别设计、验证要点与已知限制

## [0.7.0] - 2026-08-24

### 新增

- **customer 头模型级兜底注入**：`oauth.modifyModels` 在框架每次取模型目录时用当前 credential 把 `x-litellm-customer-id` 写进本 provider 全部 `model.headers`。此前 customer 头仅经 `before_provider_headers` 钩子注入，只覆盖会话主循环；扩展用裸 `pi-ai/compat` `streamSimple` 直接调 LLM 时（实测 `pi-observational-memory` 的 observer/reflector/dropper 记忆压缩调用）钩子不触发，网关侧 `end_user` 为空。模型级 stamp 经 pi-ai `createClient` 的 `mergeClientHeaders` 合并 `model.headers`，覆盖到这些绕过钩子的调用路径（anthropic-messages 主路径与 OAuth `sk-ant-oat` 路径均合）。session 头仍仅走钩子（会话级概念不属于模型）；两通道同值时请求级头（hook 产物）优先于 `defaultHeaders`（`model.headers`），无冲突。`models-store` 落盘的是原始目录，不含 stamp。新增纯函数 `stampCustomerHeader`（models.ts，可测）

### 修复

- 网关 SpendLogs 中大量单请求“神秘 session”（随机 uuid、`end_user` 为空）的归因缺失：根因为 `pi-observational-memory` 等扩展的后台 LLM 调用绕过会话钩子，既不带 customer 头也不带 trace 头（LiteLLM 对无 trace 头的请求自动生成 uuid 作 `session_id`）。模型级兜底注入后这些请求带上 customer 头，`end_user` 有值；`session_id` 仍为自动 uuid（后台跨会话压缩本无会话归属，符合预期）。端到端验证（2026-08-24）：`pi -p` 经本地转发代理抓包确认 OM 压缩请求携带 `x-litellm-customer-id`，对应 spend 行 `end_user` 由空 → 用户 email

### 文档

- CLAUDE.md / README 记录 customer 头双通道注入设计与排错提示（无 trace 头请求的 `session_id` 是网关自动 uuid，不能当作客户端 session 关联）

## [0.6.0] - 2026-08-23

### 新增

- **成本 / 用量可观测性**（移植自 balcsida `src/cost.ts`）：`after_provider_response` 读网关 `x-litellm-response-cost`（单次请求总成本，anthropic-messages 腿也返回），`message_end` 按 input/output/cache token 比例摊到 `message.usage.cost`，供 pi / omp 每轮成本展示。**pi + omp 均生效**（只用 omp 也有的两个 hook，不用 omp 缺的 `before_provider_headers`）。配置：`LITELLM_COST_TRACKING`（空串禁用，默认开）、`LITELLM_COST_HEADER`（默认 `x-litellm-response-cost` 折扣后实付，可配 `x-litellm-response-cost-original` 折扣前）
- **模型推理能力三级推断**：网关 `supports_reasoning` 布尔优先（47/53 部署有值）→ `supported_openai_params` 含 `reasoning_effort`/`thinking` → 名字前缀正则兜底（6 个稀疏模型）
- **测试套件**：`bun test`（43 个用例，零新增依赖——pi-* 为 import type 被 bun transpile 擦除）。覆盖 `extractJwtClaim`、`transformModelInfo`（模型过滤/聚合/推理/视觉）、`parseResponseCost`、`attributeCost`、cost hook 装配（provider 守卫/slot 存清/串扰防护）
- GitLab CI 增加 `test` job（`oven/bun:1`，全分支跑 `bun test`）

### 变更

- `fetchGatewayModels` 的转换逻辑抽为纯函数 `transformModelInfo`（models.ts），网络路径行为不变，可独立测试

### 修复

- `.gitignore` 的 `node_modules/` 误被注释，本地 `node_modules` 会进 git——取消注释

### 已知限制

- omp 成本跟踪的 hook 可用性经 `strings` + 反混淆推断（omp 无发布 .d.ts），**已端到端探针确认**（2026-08-23，omp 18.0.0）：`after_provider_response`+`message_end` 均触发、provider 守卫通过、APR→slot→ME→`usage.cost` 链路完整。探针另发现 LiteLLM 对 omp coding-agent 请求路由到免费别名后端（如 `claude-sonnet-5`→`glm-5.3`@智谱），网关上报成本为 0，LiteLLM 在值为 0 时省略裸 `x-litellm-response-cost`（折扣后）头，故 omp 上成本显 $0.00（准确反映免费路由）；非零展示需部署侧返回非零成本，扩展代码无需改动

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
