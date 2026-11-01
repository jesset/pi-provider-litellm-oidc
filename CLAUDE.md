# CLAUDE.md

Working guide for Claude Code / pi in this repository. Domain vocabulary lives in `CONTEXT.md`; design decisions live in `docs/adr/`.

## Project overview

pi-provider-litellm-oidc is a keyless OIDC provider extension for the pi coding agent. It obtains a JWT through the Keycloak Device Authorization Flow (RFC 8628, with PKCE) and calls the LiteLLM gateway's Anthropic-protocol endpoint `/v1/messages` with `Authorization: Bearer`. No static API key is involved. The extension supports both pi and omp (oh-my-pi).

**The extension ships no deployment defaults**: gateway URL, realm, client, provider ID and static model catalog are all supplied by the deployment.

## Key design decisions

- **The build output is the distribution**: `extension/*.ts` is bundled and minified by esbuild into a single `dist/index.js` (`build.mjs`, `npm run build`); `pi.extensions` points at it and `files` contains only `dist`, so TypeScript sources never enter the npm tarball. `dist/` is not committed: GitHub Actions builds it on `v*` tags and publishes with `npm publish --provenance`; git installs build locally through the `prepare` hook (pi runs `npm install --omit=dev`, so prepare overrides `npm_config_omit=dev` with `--include=dev` to install a pinned esbuild temporarily). The goal is to stop clients from editing the source to tamper with header injection (this only raises the bar — a git install still gets the full source)
- **Zero runtime dependencies**: Device Flow and refresh use only standard `fetch` + `URLSearchParams`; esbuild is a devDependency. The pi packages (`@earendil-works/pi-ai`, `pi-coding-agent`) are optional peerDependencies treated as esbuild externals (type-only imports; any value import would break the build)
- **Two configuration carriers**: without a config file, `LITELLM_OIDC_*` defines a single instance (fail-fast when required variables are missing); multiple instances use JSON `instances[]`, discovered as explicit `LITELLM_OIDC_CONFIG` > `$PI_CODING_AGENT_DIR/litellm-oidc.json` > runtime default (pi `~/.pi/agent`; omp derived from `PI_CONFIG_DIR`/profile, default `~/.omp/agent`). A config file fully replaces env instance config. `extension/config.ts` normalizes everything into `InstanceConfig[]` and each instance registers its own provider. Strict schema: unknown fields, missing required fields, duplicate/invalid provider IDs, collisions with the pi+omp built-in registries, and non-HTTPS URLs all fail at load time
- **The framework owns the auth lifecycle**: credential persistence, pre-expiry refresh (5-minute window) and concurrency locks are all managed by Pi; the extension only implements `login` / `refreshToken` / `getApiKey` and keeps no cache or timers. Keycloak refresh-token rotation must return the new refresh token intact (`toCredentials`) — dropping it breaks the next refresh
- **Backoff for transient refresh failures**: `refreshAccessToken` keeps a 5-second backoff window keyed by instance + refresh token to prevent a refresh stampede during a Keycloak blip. Only transient errors are recorded; OAuth semantic errors such as `invalid_grant` are rethrown to force re-login, and expired tokens are not backed off
- **HTTPS enforcement**: `assertSecureUrl` validates gateway, Keycloak and model-level baseUrl as https (loopback exempt), keeping JWTs and refresh tokens off plaintext connections
- **Three-tier model catalog**: per-instance static fallback (`fallbackModels`, empty by default) + network refresh (`/model/info`, which the gateway must list in `public_routes`) + persistence via `context.publish({ persist })`. `refreshModels` follows the two-phase protocol strictly: `allowNetwork=false` never touches the network. **`/v1/models` is not used**: it derives mode/max_tokens from LiteLLM's static cost map keyed by public model name, so self-hosted and alias models are missing; `/model/info` returns deployment-level DB values. Abort uses `AbortSignal.any([context.signal, local 15s timeout])`
- **Filtering and aggregation**: drop entries whose mode is explicitly embedding/rerank/audio_*/video/realtime/batch/ocr (a missing mode is not used for exclusion); hide the `-openai` suffix (OpenAI protocol-leg twin); aggregate same-name deployments (first non-empty scalar, max for cost as an upper bound). Capabilities aggregate all-true: vision requires every deployment to declare true; reasoning uses any-explicit-false veto
- **Thinking levels**: `getSupportedThinkingLevels` requires an explicit `thinkingLevelMap` declaration for `xhigh`/`max`, and `mapped === null` is a generic menu exclusion. `resolveEffortLevels` reads the gateway's `reasoning_effort_levels` (intersected across same-name deployments) or `supports_{xhigh,max}_reasoning_effort`: with levels, the menu mirrors the set exactly (levels inside pass their own effort through, default levels outside are excluded with `null`, the gateway's `none` is off; an empty intersection counts as undeclared); without levels, the `{ max: "max" }` fallback applies. `compat.forceAdaptiveThinking` is kept for every reasoning model — effort can only travel through the adaptive branch's `output_config.effort`, since the budget path cannot express level enums
- **Session / customer identity injection** (pi only): `before_provider_headers` filters by `ctx.model.provider` and injects `x-litellm-trace-id` (session aggregation, stored in SpendLogs.session_id) and `x-litellm-customer-id` (user attribution) into registered instances only. The customer value is decoded from the JWT in the final request's `Authorization: Bearer` header (no signature verification — it only mirrors a claim of the same token). **Two channels for the customer header**: `oauth.modifyModels` stamps it into `model.headers`, covering raw `streamSimple` calls that bypass the session hook; the session header stays hook-only (a session id is not a model property)
- **Cost observability** (pi + omp): `after_provider_response` stores `x-litellm-response-cost` in a per-provider pending slot (a headerless response clears it), and `message_end` distributes it into `message.usage.cost` by token ratio. Pure functions: `parseResponseCost` / `attributeCost`
- **Non-chat modalities**: `/model/info` mode drives routing — `image_generation`/`image_edit` → pi `type:"image"`; `decisions`/`evaluation` → `type:"classifier"`. Both API implementations must be registered explicitly on `ProviderConfig`: `litellm-images` (`/v1/images/generations` JSON or `/v1/images/edits` multipart) and `litellm-decisions` (System One wire `/v1/systemone`, bool↔noul). Authentication uses the framework-injected `options.apiKey`; the customer header arrives through the model.headers stamp; the session header is not injected. Errors never throw — they return a result shape with `stopReason: error`
- **Dual-runtime compatibility**: pi and omp both call `oauth.login` with legacy `OAuthLoginCallbacks`, but omp's callback object lacks `onDeviceCode`/`onSelect`. Device-code display probes three tiers: `onDeviceCode` → `onAuth` (verificationUri as URL, userCode in instructions) → `notify({type:"device_code"})`. Detection uses runtime `typeof === "function"` checks rather than framework type declarations

## Development workflow

```bash
npm install --no-audit --no-fund   # installs esbuild; prepare builds once
npm run build                      # bundle + minify → dist/index.js
bun test                           # unit tests (bun runs .ts natively, zero deps)
npm run supply-chain:guard         # publish-artifact invariants (build first)

# typecheck (machine-agnostic: npm root -g resolves npm/nvm/Homebrew global paths)
npm install --no-save typescript@5 @types/node@22
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_ROOT/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
./node_modules/.bin/tsc -p tsconfig.json
rm -rf node_modules
```

Order matters: `npm install` first, then the symlinks (npm would clean them up). `--no-save` keeps package.json unchanged. Neither tsc nor bun is a runtime dependency (Pi loads `.ts` through jiti, transpile-only, no type checking).

- Git conventions: Conventional Commits; feature branches `feat/<kebab-case>`; update CHANGELOG before merging into main
- When behavior changes, update README.md, README.zh-cn.md, docs/configuration.md, docs/configuration.zh-cn.md, CONTEXT.md (vocabulary), docs/adr (decisions) and this file

## Verification checklist

- Auth: Device Flow completes (device code shown), conversations work, a second conversation after 5 minutes refreshes the JWT transparently
- Catalog: a network refresh updates `~/.pi/agent/models-store.json`, `pi --list-models` shows a matching count, a newly appearing model works in a real conversation
- Thinking levels: pick a model whose gateway declares levels and confirm the menu matches; pick max and confirm thinking blocks appear
- Session/customer: `/session-header` output is correct; gateway SpendLogs aggregate by session and attribute by customer; requests to other providers are unaffected
- Modalities: codemode `models.getModelOfType("image"/"classifier")` works end to end
- Config schema changes: an explicit bad path does not fall back, a file replaces env config, per-instance catalogs and credentials stay isolated

## Known pi platform behavior

- While logged out, `pi --list-models` does not show this provider's models (`getAvailable` filters by auth state); `--model <provider>/<id>` reporting "No API key found" proves registration succeeded
- Pi 0.84.x bundles an undici that needs Node ≥ 22
- The `git:` shorthand requires the `git@` prefix (`git:git@host:path.git@ref`); otherwise it is treated as a local path
- `registerProvider` is queued during extension loading and flushed once the runner binds; it takes effect immediately afterwards, no `/reload` needed
- omp is a single-file Bun executable with the `@oh-my-pi/pi-*` framework built in; it has no `before_provider_headers`, no `onDeviceCode`/`onSelect`, and its `ProviderConfig.headers` is static. Hooks register safely in omp but never fire
- The `ProviderConfig.headers` and `compat` schemas belong to the framework; the extension only validates shallowly and must not hardcode field whitelists

## Release

1. Update the version in `package.json` / `package-lock.json` and CHANGELOG (Keep a Changelog)
2. Run `npm run build && bun test && npm run supply-chain:guard` locally
3. Tag `vX.Y.Z` and push; the CI publish job asserts the tag matches both version fields and publishes with `--provenance` (requires the `NPM_TOKEN` repository secret)

`scripts/supply-chain-guard.mjs` enforces: no install-time scripts (`prepare` exempt), zero runtime dependencies, no non-registry dependency specs, lockfile `resolved` hosts limited to registry.npmjs.org, and an exact npm pack file whitelist.
