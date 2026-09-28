# pi-provider-litellm-oidc

Pi coding agent 的 keyless OIDC provider 扩展：经 Keycloak Device Flow 取 JWT 调用 LiteLLM 网关的 Anthropic 协议端点，模型目录与思考档位以网关声明为权威。本文件是域语言术语表；设计决策见 `docs/adr/`。

## Language

### 网关侧

**Deployment**：
`/model/info` 的一行——一个实际可路由的后端实例及其 model_info 实配。
_Avoid_: 后端、节点

**模型组（model group）**：
同名 deployment 的聚合，LiteLLM 按它轮询；一切能力聚合的单位（vision all-true、reasoning 一票否决、档位取交集）。
_Avoid_: 模型（指轮询单位时）

**档位（effort levels）**：
网关 `reasoning_effort_levels` 声明的思考档集，取值为 LiteLLM `REASONING_EFFORT` 七值：`none/minimal/low/medium/high/xhigh/max`。
_Avoid_: effort 档、推理级别

### pi 侧

**思考级别（thinking level）**：
pi 思考菜单的七档：`off/minimal/low/medium/high/xhigh/max`。与档位一一对应，唯一命名差异是 `none`↔`off`。
_Avoid_: 档位（指 pi 菜单时）

**菜单排除（null exclusion）**：
`thinkingLevelMap` 中值为 `null` 的档从菜单移除——pi 的通用机制，非 off 专属。
_Avoid_: off-null 陷阱（专指无据盲用的反面案例）

### 映射与兜底

**精确对齐（exact alignment）**：
网关已声明档位时，菜单与档集一一映射：档集内直传自身 effort 值，档集外显式排除，未知档名忽略。
_Avoid_: 近似对齐

**档位兜底（level fallback）**：
网关未声明档位（或同名组交集为空）时的默认菜单行为：仅显式声明 max，其余默认档可选（v0.8.0 起行为）。
_Avoid_: hack 兜底

**网关声明权威（gateway authority）**：
模型能力以网关 model_info 为唯一权威，客户端不修补权威数据——网关误配直接反映到用户菜单。
_Avoid_: 客户端纠错
