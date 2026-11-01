# pi-provider-litellm-oidc

[![npm version](https://img.shields.io/npm/v/pi-provider-litellm-oidc)](https://www.npmjs.com/package/pi-provider-litellm-oidc)
[![CI](https://github.com/jesset/pi-provider-litellm-oidc/actions/workflows/ci.yml/badge.svg)](https://github.com/jesset/pi-provider-litellm-oidc/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-provider-litellm-oidc)](./LICENSE)

> 中文版：[README.zh-cn.md](README.zh-cn.md)

A keyless [pi](https://github.com/earendil-works/pi) coding-agent provider that connects to a LiteLLM gateway through Keycloak OIDC: a Device Authorization Flow (RFC 8628) yields a JWT, which is sent as `Authorization: Bearer` to the gateway's Anthropic-protocol endpoint `/v1/messages`. No static API key is ever stored. The same code works with both pi and omp (oh-my-pi).

The extension ships **no deployment defaults**: gateway URL, Keycloak realm and client all come from your deployment — environment variables for a single instance, or a JSON config file for multiple instances in one pi / omp process.

## Features

- **Keyless OIDC login**: Keycloak Device Authorization Flow (RFC 8628) with PKCE (S256); no static API key is stored, and the JWT is sent as `Authorization: Bearer` to the gateway's Anthropic-protocol endpoint
- **Framework-managed auth lifecycle**: credential persistence, refresh five minutes before expiry, refresh-token rotation and concurrency locks are handled by Pi; the extension only implements the three OAuth callbacks
- **Multiple gateways in one process**: one instance from environment variables, or several independent providers from a JSON `instances[]` file, each with its own credentials, catalog and login namespace
- **Gateway-driven model catalog**: pulled from `/model/info`, persisted per provider, with per-instance static fallback; reasoning, vision, token limits and per-token cost are inferred from gateway metadata, with a name-regex fallback for sparse models
- **Thinking-level alignment**: the pi thinking menu mirrors the gateway's declared effort levels (exact alignment, `none` ↔ `off`, `max` supported) and uses adaptive thinking so the selected effort reaches the backend
- **Gateway spend observability**: session identity (`x-litellm-trace-id`) and customer identity (`x-litellm-customer-id`, decoded from the JWT email claim) headers, plus a model-level fallback that covers calls bypassing the session hook
- **Per-turn cost in the client**: the gateway's `x-litellm-response-cost` is attributed into `message.usage.cost`, so pi and omp both show real cost per turn
- **Non-chat modalities**: image generation/editing and structured decisions deployed on the gateway become pi image/classifier models, callable through codemode
- **Dual runtime**: one code base for pi and omp, including a three-tier probe for device-code callbacks (pi dialog → omp LoginDialog → future AuthInteraction)
- **Supply-chain hardening**: zero runtime dependencies, a minified single-file artifact, npm provenance publishing and a CI guard over the publish pipeline

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

## Documentation

- [Configuration reference](docs/configuration.md) — identity injection, cost tracking, model catalog strategy and non-chat modalities ([中文](docs/configuration.zh-cn.md))
- [Design decisions](docs/adr/) — ADRs for thinking-level alignment and multi-instance configuration
- [Domain glossary](CONTEXT.md)
- [Development guide](CLAUDE.md)
- [Changelog](CHANGELOG.md)

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

Identity injection, cost tracking, model catalog behavior and non-chat modalities are documented in the [configuration reference](docs/configuration.md).

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
npm install --no-audit --no-fund   # installs devDependencies; prepare builds once
npm run build                      # bundle + minify into dist/index.js
npm run typecheck                  # tsc against the pinned pi type packages
bun test                           # unit tests (bun runs .ts natively)
npm run docs:check                 # relative documentation links resolve
npm run supply-chain:guard         # publish-artifact invariants (build first)
```

All six steps also run in CI. TypeScript, `@types/node` and the pi type packages (pinned) are devDependencies, so a clean clone can typecheck without a global pi installation.

**The build output is the distribution**: `extension/` TypeScript sources are bundled by esbuild into a single minified `dist/index.js` (`pi.extensions` points at it). `dist` is not committed. It is built two ways: **npm releases** are built by the `Publish` workflow (`.github/workflows/publish.yml`, triggered by a GitHub Release or a manual dispatch with a tag) and published with `npm publish --provenance`; **git installs** build locally through the `prepare` hook (falling back to a temporary pinned esbuild when devDependencies are absent). TypeScript sources never enter the npm tarball (`files` contains only `dist`). esbuild is a devDependency only; runtime dependencies stay at zero.

> Since v0.5.0 the distribution moved from "source is the artifact" to a bundled artifact so that clients cannot trivially read or modify the source and tamper with header injection behavior. This only raises the bar; it cannot stop a determined user (a git install still gets the full source).

**Release pipeline integrity** (enforced in CI):

- the publish job asserts tag == `package.json` version == `package-lock.json` version and that the checked-out commit is the tagged commit, preventing a mistyped tag from silently shipping the wrong version
- `scripts/supply-chain-guard.mjs` (run in both verify and publish) enforces five invariants: no install-time scripts (`preinstall`/`install`/`postinstall`; `prepare` is exempt, git installs depend on it), zero runtime dependencies, no non-registry dependency specs (`git:`, `file:`, `link:` and friends), a lockfile `resolved` host whitelist (registry.npmjs.org only), and an exact npm pack file whitelist (`LICENSE`/`README.md`/`README.zh-cn.md`/`dist/index.js`/`package.json` only)
- publishing uses **npm trusted publishing** (OIDC), so no token secret is stored in the repository; configure the trusted publisher once on npmjs.com (repository + `publish.yml`)

These mechanisms protect the **release pipeline and dependency supply chain** (malicious dependencies, install-time scripts, non-registry sources, version drift). Client-side tamper resistance (minification) is a separate, complementary threat surface.

## License

[MIT](./LICENSE)
