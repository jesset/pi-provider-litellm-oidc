---
status: accepted
---

# Separate single-instance environment variables from multi-instance JSON configuration

One extension has to connect to several LiteLLM gateway and Keycloak deployments inside a single pi / omp process. Each deployment is called an Instance and registers as a Pi provider; credentials, model catalog, login entry point and model namespace are isolated by provider ID.

## Decision

- The `LITELLM_OIDC_*` environment variables remain the single-instance legacy configuration and provide no deployment defaults (since v0.13.0); a missing required variable fails at load time.
- Multiple instances always use the JSON file's top-level `instances[]`. When the file exists it fully replaces the environment-variable instance configuration; there is no implicit merge of a default instance with file instances.
- Discovery order: explicit `LITELLM_OIDC_CONFIG`, `$PI_CODING_AGENT_DIR/litellm-oidc.json`, then the runtime default path. pi defaults to `~/.pi/agent`; omp derives it from `PI_CONFIG_DIR` and the profile, defaulting to `~/.omp/agent`. A missing explicit path or an invalid configuration fails immediately instead of falling back to the legacy env path.
- Configuration is normalized into `InstanceConfig[]` at load time. Each instance gets its own OAuth, catalog refresh and customer-configuration closures; cross-cutting hooks and commands are registered once and then dispatch by provider.
- The file uses a strict schema: required fields, unknown fields, duplicate or invalid provider IDs, built-in provider collisions and non-HTTPS URLs all make extension loading fail.
- `fallbackModels` defaults to empty for file instances; the extension ships no built-in catalog (since v0.13.0), so a static fallback must be declared explicitly with complete `ProviderModelConfig` entries.
- `session` and `cost` stay global; `customer` supports a global default plus per-instance overrides. The corresponding global environment variables still apply in file mode, with the file's top-level block taking precedence.
- The strict-schema failure list is extended by [ADR 0003](0003-audit-run1-security-hardening.md): `fallbackModels[].headers` values that the host framework would resolve as config values (a leading `!`, `$NAME` / `${NAME}` fragments) also make extension loading fail.

## Considered Options

- **Per-instance prefixed environment variables** (`LITELLM_OIDC_INSTANCES` plus `LITELLM_OIDC_<NAME>_*`): rejected because it creates a second multi-instance carrier alongside the file, the variable count grows with every instance, and complete `fallbackModels` cannot be expressed naturally.
- **Multiple extension copies or processes**: rejected because the framework deduplicates the same extension path, physical copies depend on load order and weaken the npm-distribution tamper resistance, and multiple processes do not satisfy "available simultaneously in one instance".
- **`models.json` + `apiKey: "!command"`**: rejected because the framework caches command results in-process, which cannot carry an OAuth refresh lifecycle and bypasses the Device Flow and refresh-token rotation.
- **Switching to Pi's native `Provider` objects**: rejected because the existing legacy provider-config already supports the required multiple registrations and per-provider closures, so the switch buys nothing.
- **`compat` field whitelist validation**: rejected because that schema belongs to the framework, the two runtimes already differ (omp 18.1.3 has no `forceAdaptiveThinking`), peerDependencies are `*`, and a static whitelist would inevitably drift and reject valid configuration; the framework's own semantics for unknown `compat` fields is to ignore them. The implementation only validates that top-level values are valid JSON values.
- **Determining the host CLI from `execPath`**: omp ships as a `#!/usr/bin/env bun` script, so under a bun host `process.execPath` is bun itself and cannot identify the hosted CLI. Only `omp` / `pi` / `node` map directly; bun and anything else probe both default paths in pi → omp order and log a warning.

## Consequences

- Users of the former built-in defaults or built-in catalog need a one-time migration (v0.13.0): supply the required environment variables or switch to a config file, and declare `fallbackModels` explicitly when an offline catalog is needed.
- Enabling multiple instances also requires listing the previous instance explicitly in `instances[]`.
- Configuration errors surface at extension load time instead of producing a partially usable provider set.
- A file instance without a static fallback catalog requires its gateway to expose `/model/info` to authenticated users; otherwise there may be no selectable model after login.
- The built-in provider reserved list is a static union of the pi and omp registries and cannot be imported as a framework enum, so it must be checked after upgrading either runtime (upgrade checklist).
- `fallbackModels[].baseUrl` overrides the instance gateway URL while `authHeader` still carries the JWT, so it is subject to the same HTTPS enforcement as instance URLs (IPv4 literals in 127.0.0.0/8, localhost and ::1 are exempt; `127.*` domains are not loopback).
- Both pi and omp have been verified to register two providers from the same bundle, and omp's default-path discovery under a bun script has been verified end to end. Real dual-gateway Device Flow, conversations and refresh still need end-to-end verification before a release.
