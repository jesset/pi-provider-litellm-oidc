---
status: accepted
---

# Audit run-1 hardening: literal header values, re-validated image URLs, validate-or-strip catalog reload

Security audit run-1 (fix series 6895708 / dc880d7 / 11bba10, recorded under Unreleased in the CHANGELOG) examined the inputs the extension consumes beyond the ones it was designed around. Three medium findings shared one root cause — values crossing a trust boundary were consumed verbatim:

- **Config → shell / environment**: pi resolves model-level header values as config values at request time (`resolve-config-value`); a leading `!` executes the rest as a shell command, and `$NAME` / `${NAME}` fragments expand environment variables into the outbound request header. A deployment-supplied config file could run commands as the local user and exfiltrate environment variables to the configured gateway on every request.
- **Gateway → arbitrary origin**: the `generateImages` url-fallback branch downloaded `data[].url` verbatim, so a hostile or compromised gateway or upstream could direct the client at arbitrary origins (`http:`, `file:`, cross-origin redirects) and have the response body embedded into the conversation transcript.
- **Disk → request**: `storedModels` cast `models-store.json` entries with bare trust, so an attacker-edited entry could carry a model-level `baseUrl` redirecting JWT-bearing requests away from the config-validated gateway, plus injected `headers`.

## Decision

- **Header values are literal data, not config values**: `fallbackModels[].headers` values that the host framework would reinterpret — a leading `!`, or `$NAME` / `${NAME}` fragments — fail extension loading with the field path, the same fail-fast contract as the rest of the strict schema (see [ADR 0002](0002-multi-instance-config-file.md)). Literal values (including a `$` not followed by an identifier) pass unchanged. Rejected at load time rather than sanitized at request time, because silently rewriting a declared header would mask the deployment error.
- **Gateway-supplied image URLs are re-validated before the fallback download**: the secondary fetch applies `assertSecureUrl` (the same origin gate as every other outbound URL — https-only, loopback `http` exempt, `file:` rejected), `redirect: "error"` (cross-origin redirects are not followed) and an `image/*` content-type check before embedding the body. Failures surface as `stopReason: "error"` per the images implementation's no-throw contract.
- **Persisted catalogs reload validate-or-strip**: `storedModels` drops `baseUrl` / `headers` keys — the write side (`transformModelInfo`) never emits them, so they can only appear through post-publish disk tampering — and removes entries without a non-empty string `id`; everything else passes through unchanged, and an empty result falls back as if nothing was stored. Strip instead of reject, so one tampered entry cannot make every model unusable.

## Considered Options

- **Escaping / sanitizing header values at request time**: rejected — the values are used verbatim by design, and a sanitizer would have to mirror the host's config-value parser exactly, a forever-drifting blocklist. Load-time rejection surfaces the bad deployment immediately.
- **A separate URL gate for image downloads**: rejected — `assertSecureUrl` is shared with instance URLs and `fallbackModels[].baseUrl`, keeping one HTTPS rule (and one loopback exemption for local debug proxies) instead of a policy that drifts per call site.
- **Rejecting the whole persisted store on any anomaly**: rejected as availability-hostile — a single attacker-added entry would downgrade the instance to the static fallback (empty by default), turning tampering into a denial-of-service lever. The untrusted keys are stripped; the rest of the catalog survives.

## Consequences

- A config file that "intentionally" used `!` / `$...` header values now fails at load with an actionable field path; such values were never deployable intent, since pi would have executed them.
- Image url-fallback downloads that previously "worked" over plaintext http, cross-origin redirect chains or non-image content types now return per-item error results; nothing throws.
- The model-level override channel stays exclusively the load-time-validated `fallbackModels` config: reload never reads `baseUrl` / `headers` from the store, under any condition.
- The controls harden the deployment trust chain, not a fully compromised host: an attacker who can edit `models-store.json` can also edit the config file — that boundary is out of scope.
- Regression seams: `test/config.test.ts` (metacharacter rejection), `test/images-url.test.ts` (url fallback validation), `test/models.test.ts` (`storedModels` validate-or-strip).
