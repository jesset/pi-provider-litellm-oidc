---
status: accepted
---

# 单实例环境变量与多实例 JSON 配置分离

单个扩展需要在同一 pi / omp 进程中接入多套 LiteLLM 网关与 Keycloak 部署。每套部署称为一个 Instance，注册后对应一个 Pi provider，凭据、模型目录、登录入口与模型命名空间均按 provider ID 隔离。

## Decision

- 环境变量 `LITELLM_OIDC_*` 仅保留为单实例 legacy 配置；未发现配置文件时，行为与 v0.10.1 一致，包括 LiteLLM 默认值与内置 11 模型静态兜底目录。
- 多实例统一使用 JSON 文件顶层 `instances[]`。文件存在时完全取代环境变量中的实例配置，不做默认实例与文件实例的隐式合并。
- 文件发现顺序为：显式 `LITELLM_OIDC_CONFIG`、`$PI_CODING_AGENT_DIR/litellm-oidc.json`、运行时默认路径。pi 默认 `~/.pi/agent`；omp 按 `PI_CONFIG_DIR` 与 profile 推导，默认 `~/.omp/agent`。显式路径缺失或配置非法均直接失败，不回落 legacy。
- 配置在加载时归一化为 `InstanceConfig[]`。每个实例独立创建 OAuth、目录刷新与 customer 配置闭包；横切面 hook 与命令只注册一次，再按 provider 分发。
- 文件采用严格 schema：必填字段、未知字段、重复或非法 provider ID、内置 provider 冲突、非 HTTPS URL 均使扩展加载失败。
- 文件实例的 `fallbackModels` 缺省为空，不继承 LiteLLM 内置目录；需要静态兜底时按完整 `ProviderModelConfig` 显式声明。
- `session` 与 `cost` 保持全局；`customer` 支持全局默认值与实例级覆盖。对应的全局环境变量在文件模式下仍然有效，文件顶层同名块优先。

## Considered Options

- **实例前缀环境变量**：以 `LITELLM_OIDC_INSTANCES` 和 `LITELLM_OIDC_<NAME>_*` 描述多个实例。否决：与文件形成两套多实例载体，变量数量随实例增长，且无法自然表达完整 `fallbackModels`。
- **多份扩展副本或多进程**：每套部署独立加载一份代码。否决：同一扩展路径会被框架去重，物理副本依赖加载顺序并削弱 npm 分发防篡改；多进程不满足单实例同时可用。
- **`models.json` + `apiKey: "!command"`**：由外部命令动态取 token。否决：框架在进程内缓存命令结果，无法承担 OAuth refresh 生命周期，也绕过了 Device Flow 与 refresh token 轮换。
- **切换 Pi 原生 `Provider` 对象**：现有 legacy provider-config 已支持所需的多次注册与 per-provider 闭包，切换没有收益。

## Consequences

- 现有未使用配置文件的用户无需迁移；启用多实例时，需要把原实例也显式写入 `instances[]`。
- 配置错误会在扩展加载时直接暴露，而不是产生部分可用的 provider 集合。
- 文件实例若未声明静态兜底目录，其网关必须向已认证用户开放 `/model/info`，否则登录后可能没有可选模型。
- pi 与 omp 均已验证同一 bundle 可注册两个 provider。真实双网关 Device Flow、对话与刷新仍需作为发布前端到端验证。
- 调研与冲突裁决见 `docs/wayfinder/research/11-multi-provider-support.md`。
