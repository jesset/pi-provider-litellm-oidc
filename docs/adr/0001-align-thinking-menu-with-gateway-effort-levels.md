---
status: accepted
---

# Exact thinking-menu alignment with gateway effort declarations

The gateway's `reasoning_effort_levels` in `/model/info` is the authoritative thinking-level declaration: LiteLLM's seven `REASONING_EFFORT` values map one-to-one onto pi's seven thinking levels (the only naming difference is `none` ↔ `off`). When the levels are declared, the pi menu mirrors the declared set exactly: levels inside the set are declared as themselves in `thinkingLevelMap` (send exactly the selected effort), default-selectable levels outside the set (off/minimal/low/medium/high) are explicitly excluded with `null` (pi's `mapped === null` is a generic menu-exclusion mechanism, not off-specific), and unknown level names are ignored (LiteLLM drops unknown levels rather than erroring). Without a declaration the v0.8.0 `{max}` fallback applies.

This extends the "gateway authority" principle (same family as vision all-true aggregation and the `supports_reasoning` veto): the client does not patch authoritative data, so a gateway misconfiguration surfaces directly in the UI.

## Considered Options

- Send value for minimal/medium inside the set: pass the level itself through (chosen) vs. go through pi's serializer switch (`minimal → low`, a Claude-family approximation designed for the undeclared case). Passing through keeps effort strictly inside the declared set even when the set is shaped like `['minimal','high']` (no low), so nothing spills outside.
- Empty level intersection across same-name deployments: treat as undeclared and fall back (chosen) vs. mimic LiteLLM's "explicit empty set clears the group". Non-intersecting declarations are almost always a configuration error, and silently cutting the menu down to off is more damaging than keeping the fallback; also LiteLLM's empty-set semantics target a single deployment's explicit `[]`, which is not the same concept as an aggregate intersection.

## Consequences

- The narrower menu is a deterministic behavior change (v0.10.1): for example a `['low','high','max']` group goes from six levels to three; a leftover session level is clamped to the nearest available level by `clampThinkingLevel`.
- Null exclusion does not conflict with the "off:null trap" recorded in v0.8.0: the trap only applies when filling in values without evidence, and a level declaration is exactly that evidence (see the "Model catalog strategy" section of README and "Gateway authority" in CONTEXT.md).
- xhigh/max are edge levels (pi requires an explicit declaration for them), so when the set does not contain them no `null` exclusion is needed — not declaring them is enough to make them unselectable.
