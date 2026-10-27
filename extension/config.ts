import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface SessionConfig {
  header: string;
  prefix: string;
  clientHeader: string;
}

export interface CustomerConfig {
  header: string;
  claims: string[];
}

export interface CostConfig {
  enabled: boolean;
  header: string;
}

export interface InstanceConfig {
  providerId: string;
  displayName: string;
  gatewayBaseUrl: string;
  keycloakBaseUrl: string;
  keycloakRealm: string;
  keycloakClientId: string;
  keycloakScope: string;
  modelInfoPath: string;
  customer: CustomerConfig;
  /** undefined 仅在 legacy env 模式出现，表示沿用内置 LiteLLM 目录。 */
  fallbackModels?: ProviderModelConfig[];
}

export interface RuntimeConfig {
  instances: InstanceConfig[];
  session: SessionConfig;
  customer: CustomerConfig;
  cost: CostConfig;
  source: string;
}

export type ReadConfigFile = (path: string) => string;

const DEFAULT_SCOPE = "openid profile email offline_access";
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/**
 * 内置 provider 保留名单：pi（pi-ai 0.84.2 models.generated + radius）与
 * omp（pi-ai 18.1.3 registry/*.ts）两侧的并集。扩展无法值导入框架枚举
 * （bundle external 约束），只能静态维护——升级任一运行时后需核对同步。
 */
const PI_BUILTIN_PROVIDER_IDS = [
  "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot",
  "google", "google-vertex", "groq", "huggingface", "kimi-coding", "minimax", "minimax-cn",
  "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode",
  "opencode-go", "openrouter", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual",
  "radius", "together", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
];
const OMP_BUILTIN_PROVIDER_IDS = [
  "aiand", "aimlapi", "alibaba-coding-plan", "alibaba-token-plan", "azure", "bedrock-mantle",
  "cline-pass", "coreweave", "cursor", "deepinfra", "devin", "exa", "firepass", "gitlab-duo",
  "gitlab-duo-agent", "gmi-cloud", "google-antigravity", "google-gemini-cli", "kagi", "kilo",
  "kimi-code", "litellm", "lm-studio", "meta", "minimax-code", "minimax-code-cn", "moonshot",
  "nanogpt", "novita", "ollama", "ollama-cloud", "openai-codex-device", "opencode-zen",
  "parallel", "perplexity", "qianfan", "qwen-portal", "sakana", "siliconflow", "siliconflow-cn",
  "synthetic", "tavily", "typesafe", "umans", "venice", "vllm", "wafer-serverless", "xai-oauth",
  "yolo-auto", "zai-coding-plan", "zenmux", "zhipu-coding-plan",
];
const RESERVED_PROVIDER_IDS = new Set([...PI_BUILTIN_PROVIDER_IDS, ...OMP_BUILTIN_PROVIDER_IDS]);

const envValue = (env: NodeJS.ProcessEnv, name: string, fallback: string): string =>
  env[name]?.trim() || fallback;

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sessionFromEnv(env: NodeJS.ProcessEnv): SessionConfig {
  const raw = env.LITELLM_SESSION_HEADER;
  return {
    header: raw === undefined ? "x-litellm-trace-id" : raw.trim(),
    prefix: envValue(env, "LITELLM_SESSION_PREFIX", ""),
    clientHeader: envValue(env, "LITELLM_SESSION_CLIENT_HEADER", ""),
  };
}

function customerFromEnv(env: NodeJS.ProcessEnv): CustomerConfig {
  const raw = env.LITELLM_CUSTOMER_HEADER;
  return {
    header: raw === undefined ? "x-litellm-customer-id" : raw.trim(),
    claims: envValue(env, "LITELLM_CUSTOMER_CLAIM", "email")
      .split(",")
      .map((claim) => claim.trim())
      .filter(Boolean),
  };
}

function costFromEnv(env: NodeJS.ProcessEnv): CostConfig {
  const raw = env.LITELLM_COST_TRACKING;
  return {
    enabled: raw === undefined ? true : raw.trim() !== "",
    header: envValue(env, "LITELLM_COST_HEADER", "x-litellm-response-cost"),
  };
}

function legacyConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const customer = customerFromEnv(env);
  const instance: InstanceConfig = {
    providerId: envValue(env, "LITELLM_OIDC_PROVIDER_ID", "litellm"),
    displayName: envValue(env, "LITELLM_OIDC_DISPLAY_NAME", "LiteLLM Gateway"),
    gatewayBaseUrl: envValue(env, "LITELLM_OIDC_GATEWAY_URL", "https://litellm.example.com"),
    keycloakBaseUrl: envValue(env, "LITELLM_OIDC_KEYCLOAK_URL", "https://keycloak.example.com"),
    keycloakRealm: envValue(env, "LITELLM_OIDC_KEYCLOAK_REALM", "Example"),
    keycloakClientId: envValue(env, "LITELLM_OIDC_KEYCLOAK_CLIENT_ID", "coding-agent-cli"),
    keycloakScope: envValue(env, "LITELLM_OIDC_KEYCLOAK_SCOPE", DEFAULT_SCOPE),
    modelInfoPath: "/model/info",
    customer,
  };
  assertSecureUrl("LITELLM_OIDC_GATEWAY_URL", instance.gatewayBaseUrl);
  assertSecureUrl("LITELLM_OIDC_KEYCLOAK_URL", instance.keycloakBaseUrl);
  return {
    instances: [instance],
    session: sessionFromEnv(env),
    customer,
    cost: costFromEnv(env),
    source: "legacy-env",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`);
  return value;
}

function knownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path} 含未知字段: ${key}`);
  }
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${path} 必须是字符串`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error(`${path} 不能为空`);
  return trimmed;
}

function requiredString(value: Record<string, unknown>, key: string, path: string): string {
  if (!(key in value)) throw new Error(`${path}.${key} 为必填字段`);
  return stringValue(value[key], `${path}.${key}`);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  fallback: string,
  allowEmpty = false,
): string {
  return value[key] === undefined ? fallback : stringValue(value[key], `${path}.${key}`, allowEmpty);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`);
  return value;
}

function claimsValue(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是字符串数组`);
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function sessionBlock(value: unknown, path: string, base: SessionConfig): SessionConfig {
  if (value === undefined) return base;
  const raw = record(value, path);
  knownFields(raw, ["header", "prefix", "clientHeader"], path);
  return {
    header: optionalString(raw, "header", path, base.header, true),
    prefix: optionalString(raw, "prefix", path, base.prefix, true),
    clientHeader: optionalString(raw, "clientHeader", path, base.clientHeader, true),
  };
}

function customerBlock(value: unknown, path: string, base: CustomerConfig): CustomerConfig {
  if (value === undefined) return base;
  const raw = record(value, path);
  knownFields(raw, ["header", "claims"], path);
  return {
    header: optionalString(raw, "header", path, base.header, true),
    claims: raw.claims === undefined ? base.claims : claimsValue(raw.claims, `${path}.claims`),
  };
}

function costBlock(value: unknown, path: string, base: CostConfig): CostConfig {
  if (value === undefined) return base;
  const raw = record(value, path);
  knownFields(raw, ["enabled", "header"], path);
  return {
    enabled: raw.enabled === undefined ? base.enabled : booleanValue(raw.enabled, `${path}.enabled`),
    header: optionalString(raw, "header", path, base.header),
  };
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} 必须是非负有限数字`);
  }
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  const number = nonNegativeNumber(value, path);
  if (number === 0) throw new Error(`${path} 必须大于 0`);
  return number;
}

function modelCost(value: unknown, path: string): ProviderModelConfig["cost"] {
  const raw = record(value, path);
  knownFields(raw, ["input", "output", "cacheRead", "cacheWrite", "tiers"], path);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!(key in raw)) throw new Error(`${path}.${key} 为必填字段`);
    nonNegativeNumber(raw[key], `${path}.${key}`);
  }
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) throw new Error(`${path}.tiers 必须是数组`);
    raw.tiers.forEach((tier, index) => {
      const tierPath = `${path}.tiers[${index}]`;
      const entry = record(tier, tierPath);
      knownFields(entry, ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"], tierPath);
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"] as const) {
        if (!(key in entry)) throw new Error(`${tierPath}.${key} 为必填字段`);
        nonNegativeNumber(entry[key], `${tierPath}.${key}`);
      }
    });
  }
  return value as ProviderModelConfig["cost"];
}

/**
 * compat 透传校验：pi-ai 拥有该 schema，且 pi 与 omp 两套运行时的字段集已经不同
 * （omp 18.1.3 无 forceAdaptiveThinking、pi 0.84.2 无 litellm/cline-pass 特有字段），
 * 静态白名单必然随框架版本脱节、拒绝合法配置。这里只校验顶层值是合法 JSON 值，
 * 字段名与枚举交由框架解析——框架对未知 compat 字段的语义是忽略。
 */
function modelCompat(value: unknown, path: string): void {
  const raw = record(value, path);
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry === "object") continue;
    if (typeof entry === "boolean" || typeof entry === "string" || typeof entry === "number") continue;
    throw new Error(`${path}.${key} 必须是 JSON 值（布尔/字符串/数字/对象/数组/null）`);
  }
}

function fallbackModel(value: unknown, path: string): ProviderModelConfig {
  const raw = record(value, path);
  knownFields(
    raw,
    ["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "headers", "compat"],
    path,
  );
  requiredString(raw, "id", path);
  requiredString(raw, "name", path);
  if (raw.api !== undefined) stringValue(raw.api, `${path}.api`);
  if (raw.baseUrl !== undefined) {
    // 模型级 baseUrl 覆盖 provider 网关地址，authHeader 仍会携带 JWT——同受 HTTPS 强制
    assertSecureUrl(`${path}.baseUrl`, stringValue(raw.baseUrl, `${path}.baseUrl`));
  }
  if (raw.reasoning === undefined) throw new Error(`${path}.reasoning 为必填字段`);
  booleanValue(raw.reasoning, `${path}.reasoning`);
  if (!Array.isArray(raw.input) || raw.input.length === 0) throw new Error(`${path}.input 必须是非空数组`);
  raw.input.forEach((entry, index) => {
    if (entry !== "text" && entry !== "image") throw new Error(`${path}.input[${index}] 只允许 text 或 image`);
  });
  if (raw.cost === undefined) throw new Error(`${path}.cost 为必填字段`);
  modelCost(raw.cost, `${path}.cost`);
  if (raw.contextWindow === undefined) throw new Error(`${path}.contextWindow 为必填字段`);
  positiveNumber(raw.contextWindow, `${path}.contextWindow`);
  if (raw.maxTokens === undefined) throw new Error(`${path}.maxTokens 为必填字段`);
  positiveNumber(raw.maxTokens, `${path}.maxTokens`);
  if (raw.thinkingLevelMap !== undefined) {
    const map = record(raw.thinkingLevelMap, `${path}.thinkingLevelMap`);
    for (const [key, entry] of Object.entries(map)) {
      if (entry !== null && typeof entry !== "string") {
        throw new Error(`${path}.thinkingLevelMap.${key} 必须是字符串或 null`);
      }
    }
  }
  if (raw.headers !== undefined) {
    const headers = record(raw.headers, `${path}.headers`);
    for (const [key, entry] of Object.entries(headers)) stringValue(entry, `${path}.headers.${key}`, true);
  }
  if (raw.compat !== undefined) modelCompat(raw.compat, `${path}.compat`);
  return value as ProviderModelConfig;
}

function fallbackModelsValue(value: unknown, path: string): ProviderModelConfig[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  return value.map((entry, index) => fallbackModel(entry, `${path}[${index}]`));
}

export function parseConfigFile(raw: unknown, source: string, env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const root = record(raw, "配置文件");
  knownFields(root, ["instances", "session", "customer", "cost"], "配置文件");
  if (!Array.isArray(root.instances) || root.instances.length === 0) {
    throw new Error("配置文件.instances 必须是非空数组");
  }

  const customer = customerBlock(root.customer, "customer", customerFromEnv(env));
  const session = sessionBlock(root.session, "session", sessionFromEnv(env));
  const cost = costBlock(root.cost, "cost", costFromEnv(env));
  const seen = new Set<string>();
  const instances = root.instances.map((value, index): InstanceConfig => {
    const path = `instances[${index}]`;
    const entry = record(value, path);
    knownFields(
      entry,
      ["id", "name", "gatewayUrl", "keycloakUrl", "realm", "clientId", "scope", "modelInfoPath", "customer", "fallbackModels"],
      path,
    );
    const providerId = requiredString(entry, "id", path);
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error(`${path}.id 必须匹配 ${PROVIDER_ID_PATTERN.source}（小写字母或数字开头，不含 /）`);
    }
    // Object.prototype 属性名（constructor/toString/__proto__ 等）会命中框架存储的
    // 原型链读取（models-store 的 data[providerId] 取到继承函数，structuredClone 抛
    // DataCloneError），一律拒绝
    if (providerId in Object.prototype) {
      throw new Error(`${path}.id 不允许使用保留属性名: ${providerId}`);
    }
    if (RESERVED_PROVIDER_IDS.has(providerId)) throw new Error(`${path}.id 与内置 provider 冲突: ${providerId}`);
    const normalizedId = providerId.toLowerCase();
    if (seen.has(normalizedId)) throw new Error(`instances 中 provider id 重复: ${providerId}`);
    seen.add(normalizedId);

    const gatewayBaseUrl = requiredString(entry, "gatewayUrl", path);
    const keycloakBaseUrl = requiredString(entry, "keycloakUrl", path);
    assertSecureUrl(`${path}.gatewayUrl`, gatewayBaseUrl);
    assertSecureUrl(`${path}.keycloakUrl`, keycloakBaseUrl);
    const modelInfoPath = optionalString(entry, "modelInfoPath", path, "/model/info");
    if (!modelInfoPath.startsWith("/")) throw new Error(`${path}.modelInfoPath 必须以 / 开头`);

    return {
      providerId,
      displayName: requiredString(entry, "name", path),
      gatewayBaseUrl,
      keycloakBaseUrl,
      keycloakRealm: requiredString(entry, "realm", path),
      keycloakClientId: requiredString(entry, "clientId", path),
      keycloakScope: optionalString(entry, "scope", path, DEFAULT_SCOPE),
      modelInfoPath,
      customer: customerBlock(entry.customer, `${path}.customer`, customer),
      fallbackModels: entry.fallbackModels === undefined
        ? []
        : fallbackModelsValue(entry.fallbackModels, `${path}.fallbackModels`),
    };
  });

  return { instances, session, customer, cost, source };
}

function expandPath(value: string, homeDir: string): string {
  if (value === "~") return resolve(homeDir);
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homeDir, value.slice(2));
  return resolve(value);
}

function ompDefaultConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const root = env.PI_CONFIG_DIR?.trim() ? expandPath(env.PI_CONFIG_DIR.trim(), homeDir) : join(homeDir, ".omp");
  const profile = env.OMP_PROFILE?.trim() || env.PI_PROFILE?.trim();
  const agentDir = profile && profile !== "default" ? join(root, "profiles", profile, "agent") : join(root, "agent");
  return join(agentDir, "litellm-oidc.json");
}

function defaultConfigPaths(env: NodeJS.ProcessEnv, execPath: string, homeDir: string): string[] {
  const piPath = join(homeDir, ".pi", "agent", "litellm-oidc.json");
  const ompPath = ompDefaultConfigPath(env, homeDir);
  const executable = basename(execPath).toLowerCase().replace(/\.exe$/, "");
  // omp 以 #!/usr/bin/env bun 脚本分发（实测 18.1.3）——bun 宿主下 execPath 是 bun
  // 本身，无法凭它区分承载的是 omp 还是 pi，只能按 pi → omp 顺序探测两个默认路径
  if (executable === "omp") return [ompPath];
  if (["pi", "node", "nodejs"].includes(executable)) return [piPath];
  console.error(
    `[pi-provider-litellm-oidc] 无法从 ${execPath} 确定宿主 CLI，按 pi → omp 顺序探测配置文件；` +
      "如需精确指定请设置 LITELLM_OIDC_CONFIG 或 PI_CODING_AGENT_DIR",
  );
  return [piPath, ompPath];
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseConfigText(text: string, path: string, env: NodeJS.ProcessEnv): RuntimeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`配置文件 JSON 解析失败: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseConfigFile(raw, `file:${path}`, env);
  } catch (error) {
    throw new Error(`配置文件无效: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadConfigFile = (path) => readFileSync(path, "utf8"),
  execPath: string = process.execPath,
  homeDir: string = homedir(),
): RuntimeConfig {
  const explicit = env.LITELLM_OIDC_CONFIG?.trim();
  if (explicit) {
    const path = expandPath(explicit, homeDir);
    let text: string;
    try {
      text = readFile(path);
    } catch (error) {
      throw new Error(`LITELLM_OIDC_CONFIG 指向的配置文件不可读: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseConfigText(text, path, env);
  }

  const candidates: string[] = [];
  if (env.PI_CODING_AGENT_DIR?.trim()) {
    candidates.push(join(expandPath(env.PI_CODING_AGENT_DIR.trim(), homeDir), "litellm-oidc.json"));
  }
  candidates.push(...defaultConfigPaths(env, execPath, homeDir));

  for (const path of [...new Set(candidates)]) {
    let text: string;
    try {
      text = readFile(path);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw new Error(`配置文件不可读: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseConfigText(text, path, env);
  }
  return legacyConfig(env);
}

export function assertSecureUrl(name: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} 不是合法 URL: ${url}`);
  }
  // loopback 例外：localhost / ::1 / 127.0.0.0/8。必须先确认是 IPv4 字面量再判
  // 127 前缀——`127.evil.example.com` 是攻击者可注册的合法域名，startsWith("127.")
  // 会误放行
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return;
  throw new Error(
    `${name} 必须使用 https（当前 ${url}）：http 会明文发送 JWT 与 refresh token，仅 loopback 主机例外`,
  );
}
