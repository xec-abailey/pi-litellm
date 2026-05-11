import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PROVIDER_NAME = "litellm";
export const ENV_BASE_URL = "LITELLM_BASE_URL";
export const ENV_API_KEY = "LITELLM_API_KEY";
export const ENV_TIMEOUT = "LITELLM_DISCOVERY_TIMEOUT_MS";
export const ENV_OFFLINE = "LITELLM_OFFLINE";
export const DEFAULT_BASE_URL = "http://localhost:4000";
export const DEFAULT_API_KEY = "sk-cedar-local";
export const DEFAULT_API = "openai-completions";
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

export type DiscoverySource = "model_info" | "models_list";

export interface ProviderModelConfig {
  id: string;
  name: string;
  api?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsStore?: boolean; cacheControlFormat?: "anthropic" };
}

export interface CacheFile {
  baseUrl: string;
  apiKeyFingerprint: string;
  fetchedAt: number;
  source: DiscoverySource;
  models: ProviderModelConfig[];
}

export interface DiscoveryResult {
  models: ProviderModelConfig[];
  source: DiscoverySource;
}

export interface DiscoveryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ModelInfoEntry {
  model_name?: string;
  litellm_params?: { model?: string };
  model_info?: {
    mode?: string;
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    supports_reasoning?: boolean;
    supports_vision?: boolean;
  };
}

export interface ModelInfoResponse {
  data?: ModelInfoEntry[];
}

export interface ModelsListEntry {
  id?: string;
}

export interface ModelsListResponse {
  data?: ModelsListEntry[];
}

export type AuthFileEntry =
  | { type: "oauth"; access: string; refresh: string; expires: number; baseUrl?: string }
  | { type: "api_key"; key: string };

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  providerApiKey: string;
  api: string;
}

export interface ResolveConfigOptions {
  agentDir?: string;
  modelsJsonPath?: string;
  defaultBaseUrl?: string;
  defaultApiKey?: string;
  defaultApi?: string;
}

interface ModelsJsonProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
}

const ANTHROPIC_MODEL_PATTERN = /^(anthropic\/|claude|opus|sonnet|haiku)/i;

export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "").replace(/\/v1\/?$/i, "");
}

export function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function buildCompat(modelId: string): ProviderModelConfig["compat"] {
  if (ANTHROPIC_MODEL_PATTERN.test(modelId)) {
    return { supportsStore: false, cacheControlFormat: "anthropic" };
  }
  return { supportsStore: false };
}

function inferModelMeta(id: string): Pick<ProviderModelConfig, "reasoning" | "contextWindow" | "maxTokens"> {
  const lower = id.toLowerCase();
  const isOpus = lower.includes("opus");
  const isSonnet = lower.includes("sonnet");
  const isHaiku = lower.includes("haiku");
  const isClaude = lower.includes("claude");
  const isClaude4x = /claude[\-.]?(opus|sonnet|haiku)?[\-.]?4/.test(lower);
  const isClaude3x = /claude[\-.]?3[\-.]?(5|7)/.test(lower);
  const isModernClaude = isClaude4x || isClaude3x || lower.startsWith("opus") || lower.startsWith("sonnet");

  return {
    reasoning: isModernClaude,
    contextWindow: isClaude || isModernClaude ? 200_000 : DEFAULT_CONTEXT_WINDOW,
    maxTokens: isOpus ? 32_768 : isSonnet ? 16_384 : isHaiku ? 8192 : DEFAULT_MAX_TOKENS,
  };
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchJson<T>(
  url: string,
  apiKey: string,
  options: DiscoveryOptions,
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, cancel } = withTimeout(timeoutMs, options.signal);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json()) as T;
    return { ok: true, data };
  } finally {
    cancel();
  }
}

function mapFromModelInfo(entry: ModelInfoEntry): ProviderModelConfig | undefined {
  const id = entry.model_name;
  if (!id) return undefined;
  const info = entry.model_info ?? {};
  if (info.mode && info.mode !== "chat") return undefined;
  const inferred = inferModelMeta(id);
  return {
    id,
    name: id,
    reasoning: info.supports_reasoning ?? inferred.reasoning,
    input: info.supports_vision ? ["text", "image"] : ["text"],
    cost: {
      input: (info.input_cost_per_token ?? 0) * 1_000_000,
      output: (info.output_cost_per_token ?? 0) * 1_000_000,
      cacheRead: (info.cache_read_input_token_cost ?? 0) * 1_000_000,
      cacheWrite: (info.cache_creation_input_token_cost ?? 0) * 1_000_000,
    },
    contextWindow: info.max_input_tokens ?? inferred.contextWindow,
    maxTokens: info.max_output_tokens ?? inferred.maxTokens,
    compat: buildCompat(id),
  };
}

function mapFromModelsList(entry: ModelsListEntry): ProviderModelConfig | undefined {
  const id = entry.id;
  if (!id) return undefined;
  const inferred = inferModelMeta(id);
  return {
    id,
    name: `${id} (no metadata)`,
    reasoning: inferred.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: inferred.contextWindow,
    maxTokens: inferred.maxTokens,
    compat: buildCompat(id),
  };
}

export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const base = normalizeBaseUrl(baseUrl);
  const infoResult = await fetchJson<ModelInfoResponse>(`${base}/model/info`, apiKey, options);
  if (infoResult.ok) {
    const models = (infoResult.data.data ?? [])
      .map(mapFromModelInfo)
      .filter((model): model is ProviderModelConfig => model !== undefined);
    return { source: "model_info", models };
  }
  if (![401, 403, 404].includes(infoResult.status)) {
    throw new Error(`/model/info returned ${infoResult.status}`);
  }

  const listResult = await fetchJson<ModelsListResponse>(`${base}/v1/models`, apiKey, options);
  if (!listResult.ok) {
    throw new Error(`/v1/models returned ${listResult.status}`);
  }
  const models = (listResult.data.data ?? [])
    .map(mapFromModelsList)
    .filter((model): model is ProviderModelConfig => model !== undefined);
  return { source: "models_list", models };
}

export function isCacheValid(cache: CacheFile | null, baseUrl: string, apiKey: string): boolean {
  if (!cache) return false;
  return cache.baseUrl === normalizeBaseUrl(baseUrl) && cache.apiKeyFingerprint === fingerprint(apiKey);
}

export async function readCache(path: string): Promise<CacheFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCacheFileShape(parsed)) return null;
  return parsed;
}

function isCacheFileShape(value: unknown): value is CacheFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.baseUrl === "string" &&
    typeof v.apiKeyFingerprint === "string" &&
    typeof v.fetchedAt === "number" &&
    (v.source === "model_info" || v.source === "models_list") &&
    Array.isArray(v.models)
  );
}

export async function writeCache(path: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await rename(tmp, path);
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  return raw
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

async function readModelsJsonProvider(path: string): Promise<ModelsJsonProviderConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(raw)) as {
      providers?: Record<string, ModelsJsonProviderConfig>;
    };
    return parsed.providers?.[PROVIDER_NAME] ?? {};
  } catch {
    return {};
  }
}

async function readAuthEntry(agentDir: string): Promise<AuthFileEntry | undefined> {
  try {
    const raw = await readFile(join(agentDir, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, AuthFileEntry>;
    return parsed?.[PROVIDER_NAME];
  } catch {
    return undefined;
  }
}

function executeCommand(commandConfig: string): string | undefined {
  try {
    const value = execSync(commandConfig.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function resolveConfigValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith("!")) return executeCommand(value);
  return process.env[value] || value;
}

export async function resolveLiteLLMConfig(options: ResolveConfigOptions = {}): Promise<LiteLLMConfig> {
  const agentDir = options.agentDir ?? join(process.env.HOME ?? "", ".pi", "agent");
  const modelsJsonPath = options.modelsJsonPath ?? join(agentDir, "models.json");
  const modelsConfig = await readModelsJsonProvider(modelsJsonPath);
  const authEntry = await readAuthEntry(agentDir);

  const authBaseUrl = authEntry?.type === "oauth" ? authEntry.baseUrl : undefined;
  const authApiKey = authEntry?.type === "oauth" ? authEntry.access : authEntry?.type === "api_key" ? authEntry.key : undefined;
  const envBaseUrl = process.env[ENV_BASE_URL];
  const envApiKey = process.env[ENV_API_KEY];
  const defaultBaseUrl = options.defaultBaseUrl ?? DEFAULT_BASE_URL;
  const defaultApiKey = options.defaultApiKey ?? DEFAULT_API_KEY;

  const rawBaseUrl = authBaseUrl || envBaseUrl || modelsConfig.baseUrl || defaultBaseUrl;
  const rawApiKey = authApiKey || (envApiKey ? ENV_API_KEY : undefined) || modelsConfig.apiKey || defaultApiKey;
  const apiKey = authEntry?.type === "oauth" ? authEntry.access.trim() : resolveConfigValue(rawApiKey);

  if (!apiKey) {
    throw new Error("LiteLLM API key is not configured");
  }

  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    apiKey,
    providerApiKey: authApiKey ? ENV_API_KEY : rawApiKey,
    api: modelsConfig.api ?? options.defaultApi ?? DEFAULT_API,
  };
}
