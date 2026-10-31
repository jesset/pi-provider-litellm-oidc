# pi-provider-litellm-oidc

> 中文版：[README.zh-cn.md](README.zh-cn.md)

A keyless [pi](https://github.com/earendil-works/pi) coding-agent provider that connects to a LiteLLM gateway through Keycloak OIDC: a Device Authorization Flow (RFC 8628) yields a JWT, which is sent as `Authorization: Bearer` to the gateway's Anthropic-protocol endpoint `/v1/messages`. No static API key is ever stored. The same code works with both pi and omp (oh-my-pi).

The extension ships **no deployment defaults**: gateway URL, Keycloak realm and client all come from your deployment — environment variables for a single instance, or a JSON config file for multiple instances in one pi / omp process.

## Architecture

```
pi / omp
  │
  │ LITELLM_OIDC_* (single instance) or litellm-oidc.json (instances[])
  │    └─ loadRuntimeConfig → one registerProvider per Instance
  │
  │ /login <provider> ──→ that instance's oauth.login(callbacks)
  │    1. POST {keycloak}/realms/{realm}/protocol/openid-connect/auth/device
  │       (public client, scope="openid profile email offline_access")
  │    2. show the device code — three-tier callback capability probe:
  │       onDeviceCode() → pi native device-code dialog
  │       onAuth()       → omp LoginDialog (verificationUri + userCode)
  │       notify()       → future AuthInteraction channel (effective automatically)
  │    3. poll the token endpoint (grant_type=urn:ietf:params:oauth:grant-type:device_code)
  │    4. return {access, refresh, expires}; the framework persists per provider:
  │       pi → ~/.pi/agent/auth.json; omp → auth_credentials table
  │
  │ at request time (managed per provider by the framework):
  │    - token near expiry (5 min window) → that instance's oauth.refreshToken() → Keycloak refresh_token grant
  │    - authHeader: true → Authorization: Bearer <JWT>
  ▼
each instance's own LiteLLM gateway (enable_jwt_auth + JWKS pointing at its Keycloak)
  └─ /v1/messages (api: "anthropic-messages")
```

## Installation

### npm (recommended)

```bash
# pi
pi install npm:pi-provider-litellm-oidc

# omp (it bundles a pi-compatible plugin loader; same syntax)
omp install npm:pi-provider-litellm-oidc
```

### git source

```bash
pi install git:git@github.com:jesset/pi-provider-litellm-oidc.git
```

### Local directory (development)

```bash
git clone https://github.com/jesset/pi-provider-litellm-oidc.git
cd pi-provider-litellm-oidc
npm install --no-audit --no-fund   # the prepare hook builds dist/index.js
```

For an already running Pi session, use `/reload` to hot-reload the extension.

### Keycloak prerequisites

- A public (non-confidential) client with the OAuth 2.0 Device Authorization Grant enabled
- **PKCE (from v0.9.1)**: the device authorization request carries `code_challenge` (S256) and token polling carries `code_verifier` (RFC 7636). Keycloak 26 and later enforce PKCE for public clients by default (client attribute `pkceCodeChallengeMethod=S256`); the extension already implements that baseline, so there is no need to disable it server-side. Older Keycloak versions ignore these parameters. A `Missing parameter: code_challenge_method` error means the extension predates v0.9.1
- The client scope must include `offline_access` (required for long-lived refresh tokens)
- The LiteLLM gateway needs `JWT_PUBLIC_KEY_URL` pointing at that realm's JWKS and `enable_jwt_auth: true`

## Usage

```text
/login my-gateway            # sign in to the single instance (Device Flow completes in any browser)
/model my-gateway/<model-id>
/logout my-gateway           # clears only that instance's credentials

# with instances[] configured, every instance has its own login, models and credential namespace
/login staging
/model staging/<model-id>
/logout staging              # does not affect my-gateway

/session-header              # show config source, per-instance login state, modality counts and header injection
```

## Configuration

### Single instance: environment variables

When no config file is found, environment variables define one instance. **The extension provides no deployment defaults**: if any required variable is missing, loading fails immediately with a configuration example.

| Variable | Required | Description |
|---|---|---|
| `LITELLM_OIDC_PROVIDER_ID` | ✓ | Pi provider ID (the prefix for `/login` and `--model`); lowercase letter or digit first; must not collide with a built-in pi / omp provider |
| `LITELLM_OIDC_GATEWAY_URL` | ✓ | LiteLLM gateway URL (must be `https://`) |
| `LITELLM_OIDC_KEYCLOAK_URL` | ✓ | Keycloak base URL (must be `https://`) |
| `LITELLM_OIDC_KEYCLOAK_REALM` | ✓ | Realm name |
| `LITELLM_OIDC_KEYCLOAK_CLIENT_ID` | ✓ | OAuth public client ID |
| `LITELLM_OIDC_DISPLAY_NAME` | | UI display name; defaults to the provider ID |
| `LITELLM_OIDC_KEYCLOAK_SCOPE` | | Defaults to `openid profile email offline_access` |

```bash
export LITELLM_OIDC_PROVIDER_ID=my-gateway
export LITELLM_OIDC_GATEWAY_URL=https://litellm.example.com
export LITELLM_OIDC_KEYCLOAK_URL=https://keycloak.example.com
export LITELLM_OIDC_KEYCLOAK_REALM=myrealm
export LITELLM_OIDC_KEYCLOAK_CLIENT_ID=coding-agent-cli
pi
```

Variables can live in the `env` block of `~/.pi/agent/settings.json`, in your shell profile, or inline (`LITELLM_OIDC_...=... pi`).

> **HTTPS enforcement (from v0.10.0)**: `LITELLM_OIDC_GATEWAY_URL` / `LITELLM_OIDC_KEYCLOAK_URL`, plus `gatewayUrl` / `keycloakUrl` / `fallbackModels[].baseUrl` in the config file, must use `https://`. An `http://` misconfiguration sends the JWT and refresh token in plaintext, so the extension fails fast at load time. Loopback hosts are exempt (`localhost`, IPv4 literals in `127.0.0.0/8`, `[::1]`) for local debug proxies; `127.*` domains are not loopback.
>
> **Backoff for transient refresh failures (from v0.10.0)**: when Keycloak is briefly down or rate-limits requests, refreshes queued behind the framework credential lock form a thundering herd. The extension keeps a 5-second backoff window keyed by instance and refresh token and returns unexpired old credentials inside it. Only transient errors (network/parse) are recorded; OAuth semantic errors such as `invalid_grant` still throw so you are forced back through `/login`; expired tokens are not backed off.

### Multiple instances: JSON config file (from v0.11.0)

A config file can register several independent providers in one pi / omp process. Each instance has its own gateway, Keycloak, credentials and model catalog. When the file exists, `instances[]` **fully replaces** the `LITELLM_OIDC_*` instance variables; nothing is merged.

Discovery order:

1. `LITELLM_OIDC_CONFIG=/path/to/litellm-oidc.json` (a relative path resolves against the current working directory);
2. `$PI_CODING_AGENT_DIR/litellm-oidc.json`;
3. runtime default paths: pi uses `~/.pi/agent/litellm-oidc.json`; omp derives from `PI_CONFIG_DIR` and `OMP_PROFILE` / `PI_PROFILE`, defaulting to `~/.omp/agent/litellm-oidc.json`. An `execPath` of `omp` probes only the omp path, `pi` / `node` only the pi path; omp ships as a `#!/usr/bin/env bun` script, so a bun host (or any other unrecognized `execPath`) probes pi → omp and logs one warning;
4. otherwise the extension falls back to the environment-variable single instance.

A missing explicit path, invalid JSON or any invalid instance field makes loading fail — there is no silent fallback. Run `/reload` after editing the file. If both pi and omp default paths exist, the first hit in the order above wins under a bun host; set `LITELLM_OIDC_CONFIG` or `PI_CODING_AGENT_DIR` explicitly to remove the ambiguity.

```json
{
  "instances": [
    {
      "id": "my-gateway",
      "name": "My LiteLLM Gateway",
      "gatewayUrl": "https://litellm.example.com",
      "keycloakUrl": "https://keycloak.example.com",
      "realm": "myrealm",
      "clientId": "coding-agent-cli"
    },
    {
      "id": "staging",
      "name": "Staging Gateway",
      "gatewayUrl": "https://litellm-staging.example.com",
      "keycloakUrl": "https://keycloak-staging.example.com",
      "realm": "staging",
      "clientId": "staging-cli",
      "scope": "openid profile email offline_access",
      "modelInfoPath": "/model/info",
      "customer": { "claims": ["email", "preferred_username"] },
      "fallbackModels": [
        {
          "id": "claude-sonnet-5",
          "name": "Claude Sonnet 5",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 64000,
          "thinkingLevelMap": { "max": "max" },
          "compat": { "forceAdaptiveThinking": true }
        }
      ]
    }
  ],
  "session": { "header": "x-litellm-trace-id", "prefix": "pi-" },
  "customer": { "header": "x-litellm-customer-id", "claims": ["email"] },
  "cost": { "enabled": true, "header": "x-litellm-response-cost" }
}
```

Required instance fields: `id`, `name`, `gatewayUrl`, `keycloakUrl`, `realm`, `clientId`. `scope` defaults to `openid profile email offline_access` and `modelInfoPath` to `/model/info`. `id` must be unique, start with a lowercase letter or digit, contain no `/`, not be a prototype-chain name such as `constructor`, and not shadow a built-in pi / omp provider (the reserved list is the union of both runtimes' registries and must be kept in sync across upgrades).

Credentials and model catalogs are isolated per `id`: pi stores them under the corresponding provider key in `~/.pi/agent/auth.json` and `~/.pi/agent/models-store.json`; omp stores them in the `auth_credentials` table and in the `models.db` provider scope.

`fallbackModels` defaults to an empty array — the extension ships no built-in catalog, so an offline static catalog must be declared explicitly with complete `ProviderModelConfig` entries. `fallbackModels[].baseUrl` overrides the request URL for that model and is subject to the same HTTPS check. `compat` fields and enums are owned by the runtime framework; the extension only validates shallow JSON values, and unknown fields may be ignored by the framework.

Optional top-level `session`, `customer` and `cost` blocks override the corresponding global environment variables: `session` accepts `header` / `prefix` / `clientHeader`, `customer` accepts `header` / `claims`, `cost` accepts `enabled` / `header`. Inside an instance only `customer` can be overridden further; `session` and `cost` stay global.

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

- The static fallback catalog is declared per instance (`fallbackModels`, empty by default), so behavior is well-defined offline and on failure
- A successful network refresh persists the catalog per provider through `context.publish({ persist })`: pi writes `~/.pi/agent/models-store.json`, omp writes `models.db`; later offline starts restore each instance's real catalog directly
- `refreshModels` follows the framework's two-phase protocol: `allowNetwork=false` (extension registration and phase 1 of every refresh) never touches the network; the network phase takes the already-refreshed access token from `context.credential` and calls `/model/info` (combined framework abort signal and a local 15s timeout)
- The data source is `/model/info`, not `/v1/models`: the former returns deployment-level DB values (token limits, `supports_vision`, mode), while the latter derives those fields from LiteLLM's static cost map keyed by public model name, so self-hosted and alias models are missing entirely and get filtered out. The gateway must list `/model/info` in `public_routes` (reachable with a user JWT)
- Filtering and routing: entries whose `mode` is explicitly embedding/rerank/audio_transcription/audio_speech/video_generation/realtime/batch/ocr are dropped (pi has no consumer channel); `image_generation`/`image_edit` become pi `type:"image"` entries and `decisions`/`evaluation` (synonyms) become `type:"classifier"` entries (see "Non-chat modalities"); a missing mode is not used for exclusion; entries with the `-openai` suffix are hidden (OpenAI protocol-leg twins of the anthropic leg); same-name deployments aggregate into one entry (first non-empty scalar for limits, max for cost fields as a conservative upper bound)
- Capability aggregation is all-true (from v0.10.0): LiteLLM round-robins a same-name model group, so `supports_vision` is only advertised when every deployment declares it (undeclared counts as unsupported — an image sent to an unsupported backend returns 500). `supports_reasoning` uses three states: any explicit false vetoes, all explicit true passes through, undeclared mixtures fall back to the inference chain. `input` contains image based on the vision verdict
- `model.cost` is read from four per-token cost fields in `/model/info` (`input_cost_per_token`/`output_cost_per_token`/`cache_read_input_token_cost`/`cache_creation_input_token_cost`), converted to pi's USD-per-million-token unit and maxed across same-name deployments, 0 when absent — complementing `x-litellm-response-cost` actuals
- `reasoning` uses a four-tier fallback: gateway `supports_reasoning` declaration tri-state → `reasoning_effort_levels` (any level implies reasoning) → `supported_openai_params` containing `reasoning_effort`/`thinking` → name-prefix regex `REASONING_MODEL_PATTERN`
- Thinking-level derivation and exact menu alignment (from v0.10.1): gateway `model_info` `reasoning_effort_levels` (the complete level set, intersected across same-name deployments, unknown names ignored) or the `supports_{xhigh,max}_reasoning_effort` booleans declare levels precisely. **With declared levels the menu mirrors the set exactly**: levels inside the set pass their own effort through (you send exactly what you select), default-selectable levels outside the set are removed with `null`, and the gateway's `none` level is pi's off (absent → `off:null`, which never sends disabled; on forced-thinking backends a disabled request would 4xx, and an explicit off request is clamped to the lowest level). **Without levels (or an empty intersection)** the `{ max: "max" }` fallback keeps the full menu. `forceAdaptiveThinking` is kept for all reasoning models (it is the effort transport: the budget path cannot express level enums). Design rationale in `docs/adr/0001`
- If the user is not logged in or the fetch fails, the instance falls back to its persisted catalog, then to its static fallback catalog

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

## Behavior you will observe

- While logged out, `pi --list-models` **will not show** this provider's models — Pi only lists models of providers that pass its auth check (`getAvailable` filters by auth state). That is Pi's design, not an extension defect
- Running `--model my-gateway/<id>` while logged out reports `No API key found for my-gateway. Use /login`, which proves the provider is registered; with multiple instances use `--model <instance-id>/<model-id>` the same way
- Full verification order: `/login` → `/model` → send a message → the model appears in the list

## Requirements

- Pi ≥ 0.81.0 (the undici bundled with 0.84.x needs Node ≥ 22; if your default node is 20, start pi through a node@22 wrapper)
- omp (oh-my-pi) ≥ 17.0 (distributed as a `#!/usr/bin/env bun` script, requires Bun; its legacy plugin compatibility shim rewrites `@earendil-works/pi-*` imports to `@oh-my-pi/pi-*`)
- Network access to Keycloak and the LiteLLM gateway

## Dual-runtime compatibility (pi / omp)

Both runtimes call the extension's `oauth.login(callbacks)` with the legacy `OAuthLoginCallbacks`, but the callback objects differ:

| Callback | pi (`adaptOAuth` adapter) | omp (legacy compatibility adapter) |
|---|---|---|
| `onDeviceCode` | provided (native device-code dialog) | **missing** |
| `onAuth` | provided | provided (renders a login dialog with a Ctrl+click URL) |
| `onPrompt` / `onProgress` | provided | provided |
| `onSelect` / `onManualCodeInput` | provided | missing |

Device-code display probes the provided callbacks in three tiers, so one code base serves both runtimes today and the next channel tomorrow:

1. `onDeviceCode` — provided by pi's `adaptOAuth` adapter, uses the native device-code dialog
2. `onAuth` — omp's legacy callbacks omit `onDeviceCode`, so the extension falls back to `onAuth`: verificationUri becomes a clickable URL and userCode goes into the instructions, which omp's LoginDialog renders as an equivalent dialog
3. `notify({type:"device_code"})` — the new `AuthInteraction` channel (pi-ai's built-in providers already use this shape; if the extension channel switches, this path lights up automatically without a release)

`refreshToken` / `getApiKey` have identical signatures in both runtimes and need no adaptation.

### Session / customer header limitation

The `before_provider_headers` hook (injecting `x-litellm-trace-id` and `x-litellm-customer-id`) **works on pi only**. omp has no `before_provider_headers` event; it only has `before_provider_request`, which operates on the API request body (`payload`: model/messages/tools/metadata), not HTTP headers, and can only replace the payload. omp's `ProviderConfig.headers` is a static `Record<string,string>` without dynamic callbacks. Requests sent by omp therefore carry no session/customer header, so the gateway cannot aggregate spend per session or attribute it per customer for omp requests. Registering the hook in omp is safe (`on()` does not validate event names; the handler is stored but never dispatched) and does not affect other functionality.

> **Cost tracking is not affected**: it uses `after_provider_response` + `message_end` (both present in omp), so it works on pi and omp alike.

## Known limitations

- Keycloak access tokens live 5 minutes by default and refreshing relies entirely on Pi's 5-minute buffer; once an offline refresh token expires, Pi asks you to `/login` again
- The four-tier `reasoning` inference depends on gateway declarations; sparse models still rely on the name regex. If a non-thinking model is misclassified, adjust `REASONING_MODEL_PATTERN` in `extension/models.ts` or fix the gateway's `supports_reasoning` / `supported_openai_params` configuration
- Thinking levels: exact menu alignment depends on the gateway's `model_info` `reasoning_effort_levels` (models without them keep the `{max:"max"}` fallback with the full menu); gateway misconfiguration surfaces directly in the user menu (the gateway is authoritative and the client does not patch it). `forceAdaptiveThinking` has not been measured on every backend; the worst case is a backend that does not think, without an error. xhigh is only selectable when the gateway declares `supports_xhigh_reasoning_effort` or includes xhigh in the level set. If a backend rejects the adaptive thinking format, that model's thinking requests will error; exempt it by model name in `ADAPTIVE_THINKING` in `extension/models.ts`
- The LiteLLM gateway must expose the Anthropic protocol endpoint (`/v1/messages`) and its JWTs must carry `preferred_username`/`email` (`litellm_jwtauth` field mapping)
- **omp limitation**: `before_provider_headers` does not fire in omp, so session/customer header injection is pi-only. A `$0.00` cost on omp usually means the gateway routed the request to a free/alias backend and reported zero cost (LiteLLM omits the bare `x-litellm-response-cost` header when the value is 0); non-zero display requires a deployment that returns non-zero cost

## Development

```bash
# build (bundle + minify into dist/index.js; npm install runs prepare automatically)
npm install --no-audit --no-fund
npm run build

# tests (bun runs .ts natively, zero dependencies; pi-* are import type and erased during transpile)
bun test        # or npm test

# publish-artifact invariants (same script CI runs in verify/publish; build first)
npm run supply-chain:guard

# typecheck (machine-agnostic setup, see CLAUDE.md for details)
npm install --no-save typescript@5 @types/node@22
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_ROOT/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
./node_modules/.bin/tsc -p tsconfig.json
rm -rf node_modules
```

**The build output is the distribution**: `extension/` TypeScript sources are bundled by esbuild into a single minified `dist/index.js` (`pi.extensions` points at it). `dist` is not committed. It is built two ways: **npm releases** are built by GitHub Actions (`.github/workflows/ci.yml`, only on `v*` tags) and published with `npm publish --provenance`; **git installs** build locally through the `prepare` hook (falling back to a temporary pinned esbuild when devDependencies are absent). TypeScript sources never enter the npm tarball (`files` contains only `dist`). esbuild is a devDependency only; runtime dependencies stay at zero.

> Since v0.5.0 the distribution moved from "source is the artifact" to a bundled artifact so that clients cannot trivially read or modify the source and tamper with header injection behavior. This only raises the bar; it cannot stop a determined user (a git install still gets the full source).

**Release pipeline integrity** (enforced in CI):

- the publish job asserts tag == `package.json` version == `package-lock.json` version before publishing, preventing a mistyped tag from silently shipping the wrong version
- `scripts/supply-chain-guard.mjs` (run in both verify and publish) enforces five invariants: no install-time scripts (`preinstall`/`install`/`postinstall`; `prepare` is exempt, git installs depend on it), zero runtime dependencies, no non-registry dependency specs (`git:`, `file:`, `link:` and friends), a lockfile `resolved` host whitelist (registry.npmjs.org only), and an exact npm pack file whitelist (`LICENSE`/`README.md`/`dist/index.js`/`package.json` only)
- CI installs with `npm ci --ignore-scripts` (skipping `prepare`) and builds explicitly with `npm run build`; publishing uses npm provenance (OIDC-signed, requires the `NPM_TOKEN` repository secret)

These mechanisms protect the **release pipeline and dependency supply chain** (malicious dependencies, install-time scripts, non-registry sources, version drift). Client-side tamper resistance (minification) is a separate, complementary threat surface.

## License

[MIT](./LICENSE)
