# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.13.0] - 2026-10-31

First public release. The extension no longer ships any deployment defaults, so upgrading requires a one-time configuration change.

### Changed

- **BREAKING (configuration)**: all deployment defaults removed. `LITELLM_OIDC_PROVIDER_ID` / `LITELLM_OIDC_GATEWAY_URL` / `LITELLM_OIDC_KEYCLOAK_URL` / `LITELLM_OIDC_KEYCLOAK_REALM` / `LITELLM_OIDC_KEYCLOAK_CLIENT_ID` are now required; a missing value fails fast at load time with a configuration example. `LITELLM_OIDC_DISPLAY_NAME` defaults to the provider ID
- **BREAKING (catalog)**: the built-in 11-model static fallback catalog is gone. `fallbackModels` defaults to an empty array in every mode (including the environment-variable single instance); an offline static catalog must be declared explicitly with complete `ProviderModelConfig` entries
- Hidden-name filtering keeps only the `-openai` suffix (OpenAI protocol-leg twins) instead of hardcoding a deployment-specific internal namespace prefix
- Package name is the unscoped `pi-provider-litellm-oidc`, published to the public npm registry; `repository` / `homepage` / `bugs` / `author` metadata added
- CI moved from GitLab CI to GitHub Actions and split into `ci.yml` (build, syntax smoke, typecheck, unit tests, documentation links and publish-artifact invariants on main and PRs) and `publish.yml` (GitHub Release or manual dispatch; tag == package.json == package-lock.json == checked-out commit assertions; publishes with `npm publish --provenance` through npm trusted publishing, no token secret)
- `scripts/supply-chain-guard.mjs` lockfile host whitelist narrowed to `registry.npmjs.org`
- Typecheck is a first-class step again: `typescript`, `@types/node` and the pi type packages (`@earendil-works/pi-ai` / `pi-coding-agent` 1.4.0) are devDependencies, so `npm run typecheck` works on a clean clone
- New `npm run docs:check` validates every relative link across README, CONTEXT, CLAUDE, CHANGELOG and `docs/`
- Documentation is English-first with Chinese mirrors (`README.zh-cn.md`, `docs/configuration.zh-cn.md`), and all commit messages are in English
- README keeps the main flow plus a feature list and the instance configuration; deeper behavior (identity injection, cost tracking, catalog strategy, non-chat modalities) moved to `docs/configuration.md`
- User-facing CLI messages are now English: configuration validation errors, `/session-header` output and the supply-chain guard output

### Removed

- Internal research notes, wayfinder tickets and agent workflow docs that only made sense for one deployment
- The `install.sh` helper script; the local development flow in the README covers the same steps

## [0.12.0] - 2026-10-28

### Added

- **Non-chat modalities (image_generation / image_edit / decisions)**: `/model/info` deployment modes drive routing — image modes produce pi `type:"image"` entries (same-name generation+edit aggregated, edit deployments declare image input), while `decisions`/`evaluation` (synonym modes) produce `type:"classifier"` entries; other non-chat modes are still excluded. Two API implementations ship with it: `litellm-images` (generateImages, routing by input to `/v1/images/generations` JSON or `/v1/images/edits` multipart, b64_json passthrough with url download fallback, size/n/quality forwarded through `options.metadata`) and `litellm-decisions` (classify, System One wire to `/v1/systemone`, bool↔noul mapping, usage backfill; catalog cost is converted from gateway per-token fields to pi `ModelCost` per-million units so classify cost accounting works — chat entries previously passed per-token values through, off by 1e6). Both share the instance OIDC credential injected by the framework (`options.apiKey`) and never throw. codemode calls them through `models.getModelOfType("image"/"classifier")` + `generateImages()`/`classify()`; `/session-header` lists per-instance modality counts
- **Image input for decisions entries (assets form)**: gateway `supports_vision` all-true aggregation (an explicit false vetoes) plus a per-instance `imageClassifiers` fallback list; classify with images sends state as an array (`<image-N>` references first), an assets map (PNG/JPEG whitelist) and the `TypeSafe-Danger-Zone-Images: true` opt-in header (required with images — the gateway's `drop_params` silently strips headerless assets and returns a confident wrong answer)

## [0.11.0] - 2026-10-27

### Added

- **Multiple LiteLLM OIDC instances in one process**: new JSON `instances[]` configuration lets one extension register several independent providers in pi / omp, each with its own gateway, Keycloak, Device Flow, credentials and model catalog. Discovery order is explicit `LITELLM_OIDC_CONFIG` > `$PI_CODING_AGENT_DIR/litellm-oidc.json` > runtime default path; when a file exists it fully replaces `LITELLM_OIDC_*` instance configuration
- **Strict configuration validation and per-instance static catalogs**: unknown fields, missing required fields, duplicate/invalid/built-in-colliding provider IDs and non-HTTPS URLs all fail fast at load time; file instances may declare complete `ProviderModelConfig` `fallbackModels` entries; instances may override the customer header and JWT claim chain
- `/session-header` reports the configuration source plus each instance's login state and session/customer injection results; new ADR `docs/adr/0002-multi-instance-config-file.md`

### Changed

- Configuration moved from a module-level singleton to a normalized `InstanceConfig[]`; Keycloak login/refresh and catalog requests take the instance configuration explicitly, and transient refresh backoff is keyed by instance + refresh token
- `session` and cost tracking stay global while the cost pending slot remains per provider; top-level `session` / `customer` / `cost` blocks override the corresponding global environment variables
- CI images now reference upstream images explicitly and pin minor versions (`node:22.23`, `bun:1.4.4`) to avoid floating-tag drift

### Tests

- `bun test` with 124 cases: file discovery and precedence, legacy compatibility, strict schema, complete `fallbackModels`, multi-instance Device Flow, header and cost dispatch, two-phase `refreshModels` isolation, `/session-header` aggregation
- Strict `tsc`, esbuild build and the supply-chain guard pass; real pi / omp registration of two providers verified in isolated agent directories

### Fixed (post-review)

- HTTPS enforcement for `fallbackModels[].baseUrl`: a model-level baseUrl overrides the instance gateway URL while the request still carries the JWT
- Loopback detection now confirms an IPv4 literal via `net.isIP` before checking 127.0.0.0/8: `127.evil.example.com` is a registrable domain that `startsWith("127.")` would wrongly accept
- omp ships as a `#!/usr/bin/env bun` script, so `execPath` cannot identify the host CLI under bun — bun and unknown `execPath` values now probe both default paths in pi → omp order with a warning
- `compat` validation changed from a field whitelist to shallow JSON value checks: the two runtimes already differ (omp 18.1.3 has no `forceAdaptiveThinking`), so a static whitelist would drift and reject valid configuration
- Provider IDs reject `constructor` and other `Object.prototype` names (a prototype-chain read in models-store makes `structuredClone` throw `DataCloneError`); the built-in reserved list expands to the union of the pi and omp registries (including `azure`, `meta`, `litellm`, `typesafe`)

## [0.10.1] - 2026-09-27

### Fixed

- **Exact alignment of the thinking menu with gateway effort declarations** (ADR `docs/adr/0001`): when `reasoning_effort_levels` is declared, `thinkingLevelMap` mirrors the set — levels inside the set are declared as themselves (send exactly the selected effort; minimal passes through instead of pi's `minimal → low` serializer approximation), default-selectable levels outside the set (off/minimal/low/medium/high) are excluded with `null` (pi's `mapped === null` is a generic menu exclusion, not off-specific), the gateway's `none` level is pi's off (included → `off:"off"` selectable, absent → `off:null`), and unknown level names are ignored (LiteLLM drops unknown levels too). Previously minimal/medium outside the set still appeared in the menu (a known 0.10.0 gap). The v0.8.0 off:null trap only applies when filling values in without evidence, and a level declaration is that evidence
- **An empty level intersection across a model group counts as undeclared**: falls back to `{max}`. Fixes a 0.10.0 edge case — levels declared but intersecting to nothing while reasoning was true by name regex produced `{off:null}`, leaving only off in the menu and losing even max
- Added domain docs: `CONTEXT.md` (glossary) and `docs/adr/0001` (this decision)

### Fixed (post-review)

- **Boolean tier reads `supports_none_reasoning_effort`** (opt-in: include none only when `true`): the boolean tier previously never contained none, so after alignment off was always `null` — a deployment configured only with booleans and `supports_none=true` lost off incorrectly
- **All-unknown level names count as undeclared**: falls through to the boolean tier instead of returning early and skipping it
- Seven-level knowledge collapsed into a single `THINKING_LEVEL_TABLE` (pi ↔ gateway ↔ edge); all other level sets derive from it
- Comment and terminology alignment with the domain docs ("level fallback" as the canonical term)

### Tests

- `bun test` with 92 cases (+5): minimal pass-through with no spillover when the set lacks low, unknown-level ignoring and all-unknown fallback, empty-intersection fallback, boolean-tier none (`off:"off"`), all-unknown fall-through; six level tests rewritten as exact-alignment assertions

## [0.10.0] - 2026-09-27

### Added

- **Backoff for transient refresh failures**: when Keycloak is briefly down or rate-limits, refreshes queued behind the pi credential lock form a thundering herd. `refreshAccessToken` keeps a 5-second backoff window keyed by refresh token and returns unexpired old credentials inside it; only transient (fetch/JSON parse) errors are recorded, OAuth semantic errors (`invalid_grant` and other 4xx) still throw to force re-login, and expired tokens are not backed off (they retry immediately). The signature now takes the whole credentials object
- **HTTPS enforcement for gateway/Keycloak URLs**: `assertSecureUrl` fails fast at module load unless `LITELLM_OIDC_GATEWAY_URL` / `LITELLM_OIDC_KEYCLOAK_URL` are https — an http misconfiguration sends the JWT and refresh token in plaintext; loopback hosts (localhost/127.x/[::1]) are exempt for local debugging
- **`model.cost` from `/model/info`**: reads four per-token cost fields (input/output/cache_read_input/cache_creation), takes a per-field max as a conservative upper bound across same-name deployments, and keeps 0 when absent — complementing the `x-litellm-response-cost` actuals
- **Thinking-level derivation**: `reasoning_effort_levels` (the complete gateway level set, intersected across same-name deployments) is the first tier; `supports_{xhigh,max}_reasoning_effort` per-level booleans assemble the second tier; the former three-tier chain (`supports_reasoning` tri-state > `supported_openai_params` > name regex) moves down to form four tiers. `thinkingLevelMap` sources diverge: with exact levels it generates edge declarations (xhigh/max values pass effort through, minimal..high use pi's default spelling), and when the level set lacks `none` (forced-thinking backends where disabled would 4xx) it declares `off:null` with justification (off leaves the menu, disabled is never sent, an explicit off request is clamped to the lowest level); without levels the `{max:"max"}` fallback stays. `forceAdaptiveThinking` is kept for every reasoning model as the effort transport

### Changed

- **Capability aggregation any → all**: `supports_vision` is only advertised when every same-name deployment declares true (LiteLLM round-robins a model group, so an unsupported backend returns 500; undeclared counts as unsupported); `supports_reasoning` keeps three states (any explicit false vetoes, all explicit true passes through, undeclared mixtures fall back) — fixing an aggregation edge case where an earlier false stuck even after a true appeared

### Tests

- `bun test` with 87 cases (+34): new test/config.test.ts (HTTPS checks), test/refresh-backoff.test.ts (all backoff boundaries), and expanded all-true aggregation and level-derivation cases in models.test.ts

## [0.9.1] - 2026-09-19

### Fixed

- **PKCE for the Device Flow (RFC 7636, S256)**: from Keycloak 26 the admin console enforces the S256 PKCE method for public clients by default (client attribute `pkceCodeChallengeMethod`) and the device authorization endpoint validates `code_challenge` — implementations without PKCE fail with `Missing parameter: code_challenge_method`. The authorization request now carries an S256 `code_challenge` and token polling carries the `code_verifier`; each login session has its own verifier, so a stolen `device_code` cannot be redeemed alone. OAuth 2.1 requires PKCE for all public-client grants, so this is the correct baseline and the check should not be disabled server-side. Older Keycloak versions ignore the parameters. The refresh grant is unaffected

### Tests

- New `test/pkce.test.ts` (+4): S256 derivation locked by the RFC 7636 Appendix B test vector, verifier format (43 unreserved characters) and high-entropy uniqueness

## [0.9.0] - 2026-08-24

### Added

- **Release supply-chain guard** (`scripts/supply-chain-guard.mjs`, `npm run supply-chain:guard`, run by both CI verify and publish): no install-time scripts (`preinstall`/`install`/`postinstall`; `prepare` stays, since git installs depend on it), zero runtime dependencies promoted from convention to CI enforcement, no non-registry dependency specs (`git:`, `file:`, `link:` …), a lockfile `resolved` host whitelist, and an exact npm pack file whitelist (`LICENSE`/`README.md`/`dist/index.js`/`package.json` only)
- **Pre-publish version assertion**: the publish job verifies tag == `package.json` version == `package-lock.json` version, preventing a mistyped tag from silently shipping the wrong version

### Changed

- CI installs dependencies with `npm ci --ignore-scripts` (verify/publish), so `prepare` is skipped and the build always runs explicitly via `npm run build` (esbuild platform binaries installed through optionalDependencies are unaffected); the CI image pins `node:22` to `node:22.23`

## [0.8.0] - 2026-08-24

### Added

- **max thinking level**: reasoning models gain `thinkingLevelMap: { max: "max" }` plus `compat: { forceAdaptiveThinking: true }` (models.ts constant `ADAPTIVE_THINKING`). pi's `getSupportedThinkingLevels` only lists `max` when `thinkingLevelMap` declares it, which is why the UI lacked max. `forceAdaptiveThinking` makes the anthropic-messages leg take the adaptive branch so effort=max travels via `output_config.effort`; otherwise the budget-based path clamps max to high and it becomes cosmetic. xhigh is not declared (no backend supports it and pi-ai's built-in catalog has none). Side effect: low/medium/high move from budget-based to effort-based (matching the official kimi/k3 anthropic-leg configuration)
- **Tests**: `bun test` with 53 cases (+7) covering `thinkingLevelMap` and `forceAdaptiveThinking` injection for reasoning and non-reasoning models, plus static-catalog consistency

## [0.7.0] - 2026-08-24

### Added

- **Model-level fallback injection of the customer header**: `oauth.modifyModels` stamps `x-litellm-customer-id` into every `model.headers` of this provider using the current credential each time the framework fetches the catalog. Previously the customer header only came from the `before_provider_headers` hook, covering the session main loop; when another extension called LLM APIs through raw `pi-ai/compat` `streamSimple` (for example memory-compression calls), the hook did not fire and the gateway saw an empty `end_user`. The model-level stamp is merged by pi-ai `createClient`'s `mergeClientHeaders`, covering those bypass paths. The session header stays hook-only (a session id is not a model property); when both channels carry the same value the request-level header (hook output) wins over `defaultHeaders` (`model.headers`), so there is no conflict. models-store persists the raw catalog without the stamp. New pure function `stampCustomerHeader` (models.ts, tested)

### Fixed

- Attribution gap for the many single-request "orphan sessions" in gateway SpendLogs (random uuid, empty `end_user`): the root cause was third-party background LLM calls bypassing the session hook, carrying neither a customer header nor a trace header (LiteLLM generates a uuid as `session_id` for trace-header-less requests). With the model-level fallback these requests now carry the customer header and `end_user` is populated; `session_id` remains an auto-generated uuid (background cross-session compression genuinely has no session association)

## [0.6.0] - 2026-08-23

### Added

- **Cost / usage observability** (`extension/cost.ts`): `after_provider_response` reads the gateway's `x-litellm-response-cost` (total cost of one request, also returned on the anthropic-messages leg) and `message_end` distributes it across input/output/cache tokens into `message.usage.cost` for pi / omp per-turn cost display. **Works on both pi and omp** (only the two hooks omp also provides; the missing `before_provider_headers` is not used). Configuration: `LITELLM_COST_TRACKING` (empty string disables, on by default), `LITELLM_COST_HEADER` (defaults to post-discount `x-litellm-response-cost`; `x-litellm-response-cost-original` gives the pre-discount price)
- **Three-tier reasoning inference**: gateway `supports_reasoning` boolean first → `supported_openai_params` containing `reasoning_effort`/`thinking` → name-prefix regex fallback
- **Test suite**: `bun test` (43 cases, zero new dependencies — pi-* are type imports erased by bun's transpiler). Covers `extractJwtClaim`, `transformModelInfo` (filtering/aggregation/reasoning/vision), `parseResponseCost`, `attributeCost`, and cost-hook wiring (provider guard, slot set/clear, cross-request isolation)
- CI gains a unit-test job running `bun test` on every branch

### Changed

- The conversion logic in `fetchGatewayModels` is extracted into the pure function `transformModelInfo` (models.ts); the network path is unchanged, and the function is independently testable

### Fixed

- `.gitignore` had `node_modules/` commented out, which would stage local installs — uncommented

## [0.5.3] - 2026-08-23

### Fixed

- omp (oh-my-pi, a compiled binary) compatibility plus forward-looking AuthInteraction support: device-code display now probes the runtime's callback capabilities in three tiers — `onDeviceCode` first (pi's `adaptOAuth` adapter provides it, using the native dialog), falling back to `onAuth` (omp's legacy callbacks omit `onDeviceCode`; verificationUri becomes a clickable URL and userCode goes into the instructions, which omp's LoginDialog renders equivalently), and finally `notify({type:"device_code"})` (the new AuthInteraction channel; if the extension channel switches later, this path activates automatically without a release). Fixes `e.onDeviceCode is not a function` on omp

### Known limitation

- omp has no `before_provider_headers` event (only `before_provider_request`, which operates on the API request body, not HTTP headers), so session/customer header injection (`x-litellm-trace-id` / `x-litellm-customer-id`) only works on pi; omp requests carry no such headers and the gateway cannot aggregate sessions or attribute customers for them

## [0.5.2] - 2026-08-19

### Changed

- README install section gains a one-liner persistent `~/.npmrc` configuration

## [0.5.1] - 2026-08-19

### Fixed

- The `prepare` hook changed from "fail then fall back" (the first `node build.mjs` always failed with an `ERR_MODULE_NOT_FOUND` stack when devDependencies were absent) to "probe then build" (`test -d node_modules/esbuild || npm install ... ; node build.mjs`), so both git installs and development installs build exactly once with no scary output; CI publishing (where `npm ci` already installed devDependencies) skips the fallback

## [0.5.0] - 2026-08-19

### Changed

- **BREAKING (distribution)**: the published artifact changed from TypeScript sources to an esbuild-bundled, minified single file `dist/index.js` (`pi.extensions` points at it; `extension/` sources no longer enter the npm tarball). The goal is to keep clients from reading or editing the source and tampering with gateway-side session/customer header injection. This only raises the bar; a git install still receives the full source
- New CI release pipeline: a verify job (build + syntax smoke on push/MR) and a publish job triggered only by `v*` tags
- `dist/` is not committed: npm publishing builds it in CI; git installs build locally through the `prepare` hook (the fallback passes `--include=dev` to override the `npm_config_omit=dev` npm passes in, installing a temporary pinned esbuild)
- Development workflow adjusted accordingly: `npm install` builds through prepare; the typecheck steps are unchanged (see the README development section)

## [0.4.1] - 2026-08-17

### Changed

- The catalog data source switched from `/v1/models` to `/model/info` (the gateway must list it in `public_routes`): the former derives mode/max_tokens from LiteLLM's static cost map keyed by public model name, so self-hosted and alias models are missing and a `mode=chat` whitelist filtered out models that are actually usable; the latter returns deployment-level DB values
- Filtering became a mode denylist (embedding/rerank/image_generation) plus hiding the `-openai` protocol-leg twin; same-name deployments aggregate; `input` follows `supports_vision` (undeclared treats the model as text-only, avoiding 500s when sending images to non-multimodal backends)
- `reasoning` prefixes extended with `kimi/`, `k3` and `llm-`

### Fixed

- README: added `zai\/glm-` to the reasoning prefix list, matching `REASONING_MODEL_PATTERN` in models.ts

## [0.4.0] - 2026-08-16

### Changed

- **BREAKING**: the environment variable prefix switched from `GATEWAY_*` to `LITELLM_OIDC_*` (seven connection variables), with no dual-read compatibility

## [0.3.2] - 2026-08-16

### Fixed

- Honor pi runtime contracts: the two-phase model refresh protocol (`allowNetwork=false` means zero network), request header injection (`before_provider_headers`), and Device Flow error classification by OAuth semantics (backoff on `slow_down`, fail fast on `access_denied`/`expired_token`)

## [0.3.1] - 2026-08-16

### Added

- Inject the `x-litellm-customer-id` header: derive the user identity from the access token's (JWT) email claim so the gateway can attribute spend per user; `LITELLM_CUSTOMER_*` variables configure the header name and claim fallback chain

### Fixed

- The typecheck development flow is machine-agnostic (resolves npm/nvm/Homebrew global paths automatically, no bun dependency)

## [0.3.0] - 2026-08-16

### Changed

- The default session header switched from `x-session-id` to `x-litellm-trace-id` (the highest-priority header in LiteLLM's native parsing chain, written to SpendLogs.session_id; the old value does not match the gateway's `^x-.+-session-id$` regex and was ignored). `LITELLM_SESSION_HEADER` restores the old behavior

## [0.2.0] - 2026-08-16

### Added

- Inject a stable session id header (the Pi session UUID) so multiple requests of one session aggregate into the same LiteLLM SpendLogs session; `LITELLM_SESSION_*` variables configure the header name, prefix and client attribution header

## [0.1.0] - 2026-08-16

### Added

- Keycloak Device Authorization Flow (RFC 8628) login with no static API key
- Call the LiteLLM gateway's Anthropic-protocol endpoint `/v1/messages` with `Authorization: Bearer`
- The auth lifecycle (credential persistence, automatic refresh before expiry, concurrency locks) is delegated to the Pi framework
- Three-tier model list strategy: static fallback + `/v1/models` network refresh + models-store offline recovery
- Every deployment parameter supplied through environment variables
- `/session-header` command to inspect injection config and the current session id

[0.13.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jesset/pi-provider-litellm-oidc/compare/v0.5.3...v0.6.0
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
[0.1.0]: https://github.com/jesset/pi-provider-litellm-oidc/releases/tag/v0.1.0
