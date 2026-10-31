---
status: accepted
---

# 思考级别菜单与网关档位声明精确对齐

网关 `/model/info` 的 `reasoning_effort_levels` 是思考档位的权威声明——LiteLLM `REASONING_EFFORT` 七值与 pi 思考级别七档一一对应（仅 `none`↔`off` 命名差异）。已声明时，pi 思考菜单精确对齐档集：档集内的档在 `thinkingLevelMap` 声明为自身值（选什么发什么 effort），档集外的默认可选档（off/minimal/low/medium/high）以 `null` 值显式排除（pi 的 `mapped === null` 是通用菜单排除机制，非 off 专属），未知档名忽略（LiteLLM 对未知 level 同样丢弃而非报错）。未声明时维持 v0.8.0 的 `{max}` 兜底。

这是"网关声明权威"哲学的延伸（vision all-true、supports_reasoning 一票否决同谱系）：我们不在客户端修补权威数据，网关误配直达 UI。

## Considered Options

- 档集内 minimal/medium 的发送值：直传自身（选定）vs 走 pi 序列化 switch（`minimal→low`，为无声明场景设计的 claude 族近似）——直传保证 effort 严格落在档集内，即使档集形如 `['minimal','high']`（不含 low）也不外溢。
- 同名多 deployment 档位交集为空：视同未声明、回落兜底（选定）vs 效仿 LiteLLM"显式空集清空组"——档位声明不相交几乎必然是配置错误，悄悄砍到只剩 off 比维持兜底伤害更大；且 LiteLLM 的空集语义针对单 deployment 显式 `[]`，与聚合交集不是同一概念。

## Consequences

- 菜单收窄是确定性行为变化（v0.10.1）：如 `['low','high','max']` 组的菜单从六档变三档；会话残留档位值经 `clampThinkingLevel` 自动调到最近可用档。
- `null` 排除与 v0.8.0 记录的 "off:null 黑洞陷阱" 不冲突：陷阱仅在**无据盲目补全**时成立，档集声明正是依据（取证链见 README 的「模型列表策略」与 CONTEXT.md 的「网关声明权威」）。
- xhigh/max 是 edge 档（pi 要求显式声明才可选），档集不含时无需 `null` 排除，不声明即不可选。
