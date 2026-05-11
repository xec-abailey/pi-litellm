/**
 * LiteLLM Model Sync Extension for Pi
 *
 * Discovers models from a LiteLLM proxy using /model/info when available, then
 * falls back to the OpenAI-compatible /v1/models endpoint for virtual keys.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { CacheFile, LiteLLMConfig, ProviderModelConfig } from "../lib/litellm.ts";
import {
  DEFAULT_TIMEOUT_MS,
  ENV_API_KEY,
  ENV_OFFLINE,
  ENV_TIMEOUT,
  PROVIDER_NAME,
  discoverModels,
  fingerprint,
  isCacheValid,
  normalizeBaseUrl,
  readCache,
  resolveLiteLLMConfig,
  writeCache,
} from "../lib/litellm.ts";

const LOGIN_TIMEOUT_MS = 10_000;
const CACHE_FILENAME = "litellm-models.json";

type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  baseUrl?: string;
};

type OAuthLoginCallbacks = {
  signal?: AbortSignal;
  onPrompt(input: { message: string; placeholder?: string }): Promise<string>;
  onProgress?(message: string): void;
};

type ModelWithProvider = {
  provider?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

function getCachePath(agentDir: string): string {
  return join(agentDir, CACHE_FILENAME);
}

function getDiscoveryTimeoutMs(): number {
  const raw = process.env[ENV_TIMEOUT];
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

function isOffline(): boolean {
  return process.env[ENV_OFFLINE] === "1";
}

function isListModelsMode(): boolean {
  return process.argv.includes("--list-models");
}

async function discoverWithFallback(
  config: LiteLLMConfig,
  options: { signal?: AbortSignal } = {},
): Promise<{ models: ProviderModelConfig[]; cache?: CacheFile; warning?: string }> {
  const timeoutMs = getDiscoveryTimeoutMs();
  if (isOffline()) {
    return { models: [], warning: `${ENV_OFFLINE}=1` };
  }
  if (timeoutMs === 0) {
    return { models: [], warning: `${ENV_TIMEOUT}=0` };
  }

  try {
    const result = await discoverModels(config.baseUrl, config.apiKey, {
      timeoutMs: timeoutMs === 0 ? LOGIN_TIMEOUT_MS : timeoutMs,
      signal: options.signal,
    });
    return {
      models: result.models,
      cache: {
        baseUrl: config.baseUrl,
        apiKeyFingerprint: fingerprint(config.apiKey),
        fetchedAt: Date.now(),
        source: result.source,
        models: result.models,
      },
    };
  } catch (error) {
    return { models: [], warning: error instanceof Error ? error.message : String(error) };
  }
}

function createOAuth(agentDir: string) {
  return {
    name: "LiteLLM",
    login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
      const rawBaseUrl = (
        await callbacks.onPrompt({
          message: "Enter LiteLLM proxy URL (no trailing /v1):",
          placeholder: "https://litellm.example.com",
        })
      ).trim();
      const apiKey = (await callbacks.onPrompt({ message: "Enter API key:" })).trim();
      if (!rawBaseUrl || !apiKey) throw new Error("Both base URL and API key are required");

      const baseUrl = normalizeBaseUrl(rawBaseUrl);
      const result = await discoverModels(baseUrl, apiKey, {
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: callbacks.signal,
      });

      await writeCache(getCachePath(agentDir), {
        baseUrl,
        apiKeyFingerprint: fingerprint(apiKey),
        fetchedAt: Date.now(),
        source: result.source,
        models: result.models,
      });
      callbacks.onProgress?.(`LiteLLM: ${result.models.length} models discovered (source: ${result.source})`);

      return { access: apiKey, refresh: "", expires: Number.MAX_SAFE_INTEGER, baseUrl };
    },
    refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => credentials,
    getApiKey: (credentials: OAuthCredentials): string => credentials.access,
    modifyModels: (models: ModelWithProvider[], credentials: OAuthCredentials): ModelWithProvider[] => {
      if (!credentials.baseUrl) return models;
      return models.map((model) =>
        model.provider === PROVIDER_NAME ? { ...model, baseUrl: `${credentials.baseUrl}/v1` } : model,
      );
    },
  };
}

function registerLiteLLMProvider(
  pi: ExtensionAPI,
  agentDir: string,
  config: LiteLLMConfig,
  models: ProviderModelConfig[],
): void {
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.providerApiKey || ENV_API_KEY,
    api: config.api as any,
    models,
    oauth: createOAuth(agentDir) as any,
  });
}

async function syncModels(pi: ExtensionAPI, agentDir: string, force = false): Promise<{ count: number; warning?: string }> {
  const config = await resolveLiteLLMConfig({ agentDir });
  const cachePath = getCachePath(agentDir);
  const cache = await readCache(cachePath);
  const cacheValid = isCacheValid(cache, config.baseUrl, config.apiKey);

  let models = cacheValid && cache ? cache.models : [];
  const shouldFetch = force || (!isOffline() && (!cacheValid || isListModelsMode()));

  if (shouldFetch) {
    const discovered = await discoverWithFallback(config);
    if (discovered.cache) {
      await writeCache(cachePath, discovered.cache);
      models = discovered.models;
      if (isListModelsMode()) {
        process.stderr.write(`LiteLLM: ${models.length} models discovered (source: ${discovered.cache.source}).\n`);
      }
    } else if (cacheValid && cache) {
      process.stderr.write(`LiteLLM: discovery failed (${discovered.warning}); using cached models.\n`);
      models = cache.models;
    } else if (discovered.warning) {
      process.stderr.write(`LiteLLM: discovery failed (${discovered.warning}); registering provider with no models.\n`);
    }
  }

  registerLiteLLMProvider(pi, agentDir, config, models);
  return { count: models.length };
}

export default async function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  await syncModels(pi, agentDir);

  pi.registerCommand("litellm-refresh", {
    description: "Re-discover models from the LiteLLM proxy.",
    handler: async (_args: string, ctx: any) => {
      if (isOffline()) {
        ctx.ui.notify(`LiteLLM refresh disabled (${ENV_OFFLINE}=1)`, "warning");
        return;
      }
      const timeoutMs = getDiscoveryTimeoutMs();
      if (timeoutMs === 0) {
        ctx.ui.notify(`LiteLLM refresh disabled (${ENV_TIMEOUT}=0)`, "warning");
        return;
      }
      try {
        const result = await syncModels(pi, agentDir, true);
        ctx.ui.notify(`LiteLLM: ${result.count} models refreshed`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`LiteLLM refresh failed: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (event: any) => {
    if (event.reason === "reload") {
      await syncModels(pi, agentDir, true);
    }
  });
}
