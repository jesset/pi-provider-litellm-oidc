# pi-provider-litellm-oidc

A keyless OIDC provider extension for the pi coding agent: it obtains a JWT through the Keycloak Device Flow and calls a LiteLLM gateway's Anthropic-protocol endpoint, with the gateway as the authority for the model catalog and thinking levels. This file is the domain vocabulary; design decisions live in `docs/adr/`.

## Language

### Gateway side

**Deployment**:
One row of `/model/info` — an actually routable backend instance together with its configured `model_info`.
_Avoid_: backend, node

**Model group**:
The aggregate of same-name deployments, which LiteLLM round-robins; the unit for every capability aggregation (vision all-true, reasoning veto, level intersection).
_Avoid_: model (when referring to the round-robin unit)

**Effort levels**:
The thinking level set declared by the gateway's `reasoning_effort_levels`, using LiteLLM's `REASONING_EFFORT` values: `none/minimal/low/medium/high/xhigh/max`.
_Avoid_: effort tiers, reasoning grades

### Access and configuration

**Instance**:
The access configuration for one LiteLLM gateway plus its Keycloak realm/client; an instance registers as one Pi provider.
_Avoid_: provider (when referring to the configuration unit), site, deployment instance

**Pi provider**:
The unit by which the Pi runtime registers and selects models (the prefix of `/login <id>` and `--model <id>/<model>`); credentials and model catalogs are keyed by it.
_Avoid_: instance (when referring to the Pi registration unit)

### Pi side

**Thinking level**:
One of the seven levels in pi's thinking menu: `off/minimal/low/medium/high/xhigh/max`. It maps one-to-one to effort levels, the only naming difference being `none` ↔ `off`.
_Avoid_: effort level (when referring to the pi menu)

**Null exclusion**:
A `thinkingLevelMap` entry with value `null` removes that level from the menu — a generic pi mechanism, not off-specific.
_Avoid_: off-null trap (which refers specifically to the flawed unconditional case)

### Mapping and fallback

**Exact alignment**:
When the gateway declares levels, the menu maps one-to-one onto the declared set: levels inside pass their own effort through, levels outside are explicitly excluded, unknown level names are ignored.
_Avoid_: approximate alignment

**Level fallback**:
The default menu behavior when the gateway declares no levels (or the intersection across a model group is empty): declare max explicitly and leave the other default levels selectable (behavior since v0.8.0).
_Avoid_: hack fallback

**Fallback catalog**:
The static model catalog used when `/model/info` is unavailable; it only serves offline/failure fallback, while capabilities remain governed by the gateway declaration.
_Avoid_: model list (when referring to capability declaration)

**Gateway authority**:
Model capabilities come solely from the gateway's `model_info`; the client does not patch authoritative data — a gateway misconfiguration surfaces directly in the user menu.
_Avoid_: client-side correction

### Non-chat modalities

**Mode routing**:
The mapping from a deployment `mode` in `/model/info` to a pi ModelType: image_generation/image_edit → image, decisions/evaluation → classifier, other non-chat modes on the exclusion list → dropped. Whatever the gateway deploys is what the client exposes.
_Avoid_: model filtering (when referring to image/decisions routing)

**System One wire**:
The request/response format of the `/v1/systemone` endpoint (state + questions map, type ∈ noul/choice/score), with pi's bool mapped to and from the wire's noul. LiteLLM translates between it and the OpenAI Decisions format (`/v1/decisions`), so the format choice does not affect model availability.
_Avoid_: decisions protocol (when referring to the System One format)
