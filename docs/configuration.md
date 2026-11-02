# Configuration reference

> 中文版：[configuration.zh-cn.md](configuration.zh-cn.md)

Identity injection, cost tracking, the model catalog strategy and non-chat modalities are documented here. For installation, basic usage and instance configuration, see [README.md](../README.md).

Instance configuration (required environment variables, discovery order and the `instances[]` file) is documented in the [README](../README.md#configuration). This document covers the behavior that configures the gateway integration:

- [Session / customer identity injection](#session--customer-identity-injection-gateway-aggregation-and-user-attribution)
- [Cost / usage observability](#cost--usage-observability)
- [Model catalog strategy](#model-catalog-strategy)
- [Non-chat modalities](#non-chat-modalities-image--decisions)

## Session / customer identity injection (gateway aggregation and user attribution)

The `before_provider_headers` hook injects two identities into LLM requests of **registered instances only**; requests to other providers are untouched:

1. **Session identity** (Pi session UUID): groups the requests of one session (tool-call loops, retries, multiple turns) under the same session.

   The default header `x-litellm-trace-id` has the highest priority in LiteLLM proxy's native session/trace parsing chain (`x-litellm-trace-id` > `x-litellm-session-id` > any `x-<vendor>-session-id`). The value lands in `LiteLLM_SpendLogs.session_id` and in metadata `trace_id`/`session_id`, groups the Session Logs UI, and propagates to nested MCP/A2A calls — no gateway configuration needed. Note that `x-session-id` does not match LiteLLM's `^x-.+-session-id$` regex (it lacks a vendor segment) and is ignored entirely, which is why it is not the default.

2. **Customer identity** (user email): the default header `x-litellm-customer-id` is LiteLLM proxy's standard customer/end-user header (parsed without any gateway configuration). The value populates the SpendLogs customer dimension; combined with gateway-side `user_header_mappings` and `extra_spend_tag_headers`, it can create users and aggregate per-user spend by email. The value is taken directly from the `Authorization: Bearer <token>` header the framework already put on the final request (case-insensitive lookup, strictly the same token that is sent), decoded locally from the JWT payload via base64url — no signature verification, since the same token is already being sent as the bearer credential and this only mirrors one claim. Injection is skipped when the token is not a JWT, the claim is missing, or you are logged out; requests are unaffected.

   The customer header uses **two channels** to cover every call path:
   - the **session main loop** (tool calls, multiple turns, retries) through the `before_provider_headers` hook;
   - a **model-level fallback**: `oauth.modifyModels` stamps the customer header into every `model.headers` entry using the current credential each time the framework fetches the catalog, so calls that **bypass the session hook** (third-party SDK clients, other extensions calling `pi-ai` `streamSimple` directly) still carry it via pi-ai `createClient`'s header merge. The session header remains hook-only (a session id is not a model property). The persisted models-store contains the raw catalog without the stamp.

   > Troubleshooting: "orphan sessions" in gateway SpendLogs (a random uuid on a single request) usually come from background calls without a trace header — LiteLLM generates a uuid as `session_id` in that case. The customer header now covers those calls, but requests without a trace header still have no real session association.

The following environment variables apply in both legacy and file modes; top-level `session` / `customer` blocks override them, and an instance-level `customer` block overrides them again.

| Variable | Default | Description |
|---|---|---|
| `LITELLM_SESSION_HEADER` | `x-litellm-trace-id` | Session header name; set to an empty string to disable injection |
| `LITELLM_SESSION_PREFIX` | (empty) | Optional value prefix, e.g. `pi-`; LiteLLM requires values matching `^[a-zA-Z0-9_-]{8,}$`, so prefixes containing `.`/`:` make the gateway drop the header |
| `LITELLM_SESSION_CLIENT_HEADER` | (empty) | Optional second header name (value fixed to `pi`) for gateway-side client attribution; not sent when unset |
| `LITELLM_CUSTOMER_HEADER` | `x-litellm-customer-id` | Customer header name; set to an empty string to disable injection |
| `LITELLM_CUSTOMER_CLAIM` | `email` | JWT claim names to try in order; comma-separated fallback chain, e.g. `email,preferred_username` |

Behavior notes:

- retries reuse the same headers, so the hook does not fire twice and the session id stays stable
- with multiple instances the same session id is sent to each gateway; the two gateways form independent SpendLogs groups, which does not imply a shared cross-gateway session store
- `/fork` and `/clone` create a new session file and a new UUID; sub-agents share the parent session id
- `/new` or a pi restart changes the id; `pi -c` / `--session` resumes with the original id
- the `x-litellm-trace-id` parsing chain landed upstream in 2026-03; older gateways ignore the header (injection is harmless, just without aggregation). `x-litellm-customer-id` is a standard customer header whose documented semantics are "always checked without any configuration", so it does not depend on that version

## Cost / usage observability

LiteLLM returns `x-litellm-response-cost` (total cost of one request) on `/v1/messages` (the anthropic-messages leg). Two hooks turn that into a per-turn cost on the client side:

- `after_provider_response`: reads the header into a per-provider pending slot (a response without the header clears the slot, preventing cross-request contamination)
- `message_end`: takes the pending total and distributes it across input/output/cacheRead/cacheWrite tokens into `message.usage.cost`, returning a replacement message — both pi and omp (which renders `$X.XX` itself) read `usage.cost`

**Works on both pi and omp**: cost tracking uses only `after_provider_response` + `message_end`, both present in omp; it does not use `before_provider_headers`, which omp lacks. This is orthogonal to session/customer identity: those are gateway-side spend dimensions (session_id/customer_id), while this is a client-side per-request cost value.

| Variable | Default | Description |
|---|---|---|
| `LITELLM_COST_TRACKING` | (enabled) | Enable cost tracking; set to an empty string to disable |
| `LITELLM_COST_HEADER` | `x-litellm-response-cost` | Response header to read; the default is post-discount actual cost, `x-litellm-response-cost-original` gives pre-discount list price |

## Model catalog strategy

- The static fallback catalog is declared per instance (`fallbackModels`, empty by default), so behavior is well-defined offline and on failure; model-level header values are literal values — a leading `!` or `$NAME`/`${NAME}` fragments are rejected at load time (the host framework would otherwise resolve them as config values, executing commands or expanding environment variables)
- A successful network refresh persists the catalog per provider through `context.publish({ persist })`: pi writes `~/.pi/agent/models-store.json`, omp writes `models.db`; later offline starts restore each instance's real catalog directly, after re-validating the stored entries (untrusted keys stripped: `baseUrl` / `headers` dropped, entries without a non-empty string `id` removed — see [ADR 0003](adr/0003-audit-run1-security-hardening.md))
- `refreshModels` follows the framework's two-phase protocol: `allowNetwork=false` (extension registration and phase 1 of every refresh) never touches the network; the network phase takes the already-refreshed access token from `context.credential` and calls `/model/info` (combined framework abort signal and a local 15s timeout)
- The data source is `/model/info`, not `/v1/models`: the former returns deployment-level DB values (token limits, `supports_vision`, mode), while the latter derives those fields from LiteLLM's static cost map keyed by public model name, so self-hosted and alias models are missing entirely and get filtered out. The gateway must list `/model/info` in `public_routes` (reachable with a user JWT)
- Filtering and routing: entries whose `mode` is explicitly embedding/rerank/audio_transcription/audio_speech/video_generation/realtime/batch/ocr are dropped (pi has no consumer channel); `image_generation`/`image_edit` become pi `type:"image"` entries and `decisions`/`evaluation` (synonyms) become `type:"classifier"` entries (see [Non-chat modalities](#non-chat-modalities-image--decisions)); a missing mode is not used for exclusion; entries with the `-openai` suffix are hidden (OpenAI protocol-leg twins of the anthropic leg); same-name deployments aggregate into one entry (first non-empty scalar for limits, max for cost fields as a conservative upper bound)
- Capability aggregation is all-true (from v0.10.0): LiteLLM round-robins a same-name model group, so `supports_vision` is only advertised when every deployment declares it (undeclared counts as unsupported — an image sent to an unsupported backend returns 500). `supports_reasoning` uses three states: any explicit false vetoes, all explicit true passes through, undeclared mixtures fall back to the inference chain. `input` contains image based on the vision verdict
- `model.cost` is read from four per-token cost fields in `/model/info` (`input_cost_per_token`/`output_cost_per_token`/`cache_read_input_token_cost`/`cache_creation_input_token_cost`), converted to pi's USD-per-million-token unit and maxed across same-name deployments, 0 when absent — complementing `x-litellm-response-cost` actuals
- `reasoning` uses a four-tier fallback: gateway `supports_reasoning` declaration tri-state → `reasoning_effort_levels` (any level implies reasoning) → `supported_openai_params` containing `reasoning_effort`/`thinking` → name-prefix regex `REASONING_MODEL_PATTERN`
- Thinking-level derivation and exact menu alignment (from v0.10.1): gateway `model_info` `reasoning_effort_levels` (the complete level set, intersected across same-name deployments, unknown names ignored) or the `supports_{xhigh,max}_reasoning_effort` booleans declare levels precisely. **With declared levels the menu mirrors the set exactly**: levels inside the set pass their own effort through (you send exactly what you select), default-selectable levels outside the set are removed with `null`, and the gateway's `none` level is pi's off (absent → `off:null`, which never sends disabled; on forced-thinking backends a disabled request would 4xx, and an explicit off request is clamped to the lowest level). **Without levels (or an empty intersection)** the `{ max: "max" }` fallback keeps the full menu. `forceAdaptiveThinking` is kept for all reasoning models (it is the effort transport: the budget path cannot express level enums). Design rationale in [ADR 0001](adr/0001-align-thinking-menu-with-gateway-effort-levels.md)
- If the user is not logged in or the fetch fails, the instance falls back to its persisted catalog (re-validated on reload — untrusted keys stripped), then to its static fallback catalog

## Non-chat modalities (image / decisions)

Non-chat modalities deployed on the gateway are visible to pi automatically (mode-driven, an extension of the gateway-authority principle): whatever the gateway deploys is exposed without a client release.

- **Image generation/editing** (mode `image_generation` / `image_edit`): produces pi image entries; same-name generation+edit deployments aggregate into one entry (an edit deployment declares image input). Calls route by input: all-text → `POST /v1/images/generations` (JSON, `response_format:"b64_json"`); with image blocks → `POST /v1/images/edits` (multipart). The response returns `b64_json` directly, falling back to downloading `url` when absent. `size`/`n`/`quality` pass through `options.metadata` from codemode (size defaults to 1024x1024). Image models do not appear in the `/model` picker (pi by design); agents call them through codemode:

  ```js
  // @options: {"timeout_ms": 300000}
  const painter = await models.getModelOfType("image", "my-gateway", "flux3-klein");
  const r = await models.generateImages(painter, {
    input: [{ type: "text", text: "a red fox in the snow, watercolor" }],
  });
  if (r.stopReason !== "stop") return r.errorMessage;
  for (const b of r.output) if (b.type === "image") image(b);
  ```

- **Structured decisions** (mode `decisions` / `evaluation`, synonyms): produces pi classifier entries; the System One wire calls `POST /v1/systemone` (bool↔noul mapping in both directions, answers keyed by name, usage tokens backfilled and counted into session cost). Agents call `models.classify()` from codemode to ask choice/score/bool questions and get probabilistic answers. **Image input**: when the entry's `input` contains `"image"`, `images` may be passed (assets form: reference names prepended to the state, PNG/JPEG whitelist, mandatory opt-in header — the gateway silently strips images from headerless requests and returns a wrong answer). Image capability comes from the gateway's `supports_vision` declaration (all-true across the group, explicit false vetoes); when the gateway does not declare it, the per-instance `imageClassifiers: ["<model_name>"]` list can be used. Note the TypeSafe upstream minimum image size of roughly 320px:

  ```js
  const judge = await models.getModelOfType("classifier", "my-gateway", "typesafe/jev-latest");
  const r = await models.classify(judge, {
    state: { text: "Customer charged twice for order #4411" },
    questions: {
      refund: { type: "bool", instructions: "Is this a refund request?", criteria: { true: "yes", false: "no" } },
      urgency: { type: "choice", instructions: "How urgent?", criteria: { low: "can wait", high: "today" } },
    },
  });
  if (r.stopReason !== "stop") return r.errorMessage;
  return r.answers.refund.probability;  // 0.99
  ```

- Authentication is shared with chat: both implementations reuse the instance's OIDC credential (injected by the framework after its 5-minute refresh window); the customer header travels through the model-level stamp fallback; the session header is not injected (stream-only hook limitation)
- `/session-header` lists each instance's modality counts (image × N, classifier × N)
- Cost reality: the decisions endpoint reports real token counts; the images endpoint reports all-zero usage and no `x-litellm-response-cost`, so per-request cost is 0 (`x-litellm-key-spend` is a cumulative per-key value and is not used)
- Out of scope: embedding / rerank / audio transcription / TTS / OCR / video / realtime have no matching pi ModelType and remain excluded
