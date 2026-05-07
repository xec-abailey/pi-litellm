/**
 * LiteLLM Model Sync Extension for Pi
 *
 * Keeps the Pi model selector in sync with LiteLLM's live model list.
 * On startup (and on /reload), fetches GET /v1/models from LiteLLM and
 * calls pi.registerProvider("litellm", ...) with the exact model IDs
 * that LiteLLM exposes — so the selector shows "bedrock/claude-sonnet-4.6"
 * rather than stale IDs baked into models.json.
 *
 * Configuration:
 *   Set LITELLM_BASE_URL env var or configure in models.json provider config
 *   Set LITELLM_API_KEY env var or configure in models.json provider config
 *
 * Priority: env vars > models.json provider config > defaults
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiteLLMModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface LiteLLMModelsResponse {
  data: LiteLLMModel[];
  object: string;
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive display name from model id, e.g. "bedrock/claude-sonnet-4.6" → "Claude Sonnet 4.6 (Bedrock)" */
function displayName(id: string): string {
  const [prefix, ...rest] = id.split("/");
  const modelPart = rest.join("/");
  if (!modelPart) return id;

  const prefixLabel: Record<string, string> = {
    bedrock: "Bedrock",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    azure: "Azure",
    vertex_ai: "Vertex AI",
    anthropic: "Anthropic",
    ollama: "Ollama",
  };

  const label = prefixLabel[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const human = modelPart
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return `${human} (${label})`;
}

/** Guess capabilities from model id */
function modelMeta(id: string): {
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
} {
  const lower = id.toLowerCase();

  const isOpus = lower.includes("opus");
  const isSonnet = lower.includes("sonnet");
  const isHaiku = lower.includes("haiku");
  const isClaude = lower.includes("claude");
  const isClaude4x = /claude[\-.]?(opus|sonnet|haiku)?[\-.]?4/.test(lower);
  const isClaude3x = /claude[\-.]?3[\-.]?(5|7)/.test(lower);
  const isModernClaude = isClaude4x || isClaude3x;

  const reasoning = isModernClaude;

  const contextWindow = isModernClaude ? 200000 : isClaude ? 200000 : 128000;

  const maxTokens = isOpus
    ? 32768
    : isSonnet
    ? 16384
    : isHaiku
    ? 8192
    : 16384;

  const thinkingLevelMap: Record<string, string | null> | undefined = reasoning
    ? isOpus
      ? { low: "low", medium: "medium", high: "high", xhigh: "max" }
      : { low: "low", medium: "medium", high: "high", xhigh: null }
    : undefined;

  return { reasoning, contextWindow, maxTokens, thinkingLevelMap };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(): ProviderConfig {
  const defaults: ProviderConfig = {
    baseUrl: "http://localhost:4000",
    apiKey: "sk-cedar-local",
    api: "anthropic-messages",
  };

  // Try reading from models.json for non-env-var config
  let fromModelsJson: Partial<ProviderConfig> = {};
  const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
  if (existsSync(modelsJsonPath)) {
    try {
      const raw = readFileSync(modelsJsonPath, "utf-8");
      // Strip // comments before parsing
      const stripped = raw
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
        .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
      const parsed = JSON.parse(stripped) as { providers?: Record<string, any> };
      const p = parsed?.providers?.litellm ?? {};
      fromModelsJson = {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        api: p.api,
      };
    } catch {
      // Ignore parse errors — fall through to defaults
    }
  }

  // Priority: env vars > models.json > defaults
  return {
    baseUrl: process.env.LITELLM_BASE_URL ?? fromModelsJson.baseUrl ?? defaults.baseUrl,
    apiKey: process.env.LITELLM_API_KEY ?? fromModelsJson.apiKey ?? defaults.apiKey,
    api: fromModelsJson.api ?? defaults.api,
  };
}

// ---------------------------------------------------------------------------
// Core sync function
// ---------------------------------------------------------------------------

async function syncModels(pi: ExtensionAPI): Promise<void> {
  const config = resolveConfig();

  let models: LiteLLMModel[];
  try {
    const res = await fetch(`${config.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as LiteLLMModelsResponse;
    models = payload.data ?? [];
  } catch (err) {
    console.error(
      `[litellm-sync] Failed to fetch models from ${config.baseUrl}: ${err instanceof Error ? err.message : err}`
    );
    return;
  }

  if (models.length === 0) {
    console.warn("[litellm-sync] No models returned from LiteLLM — skipping registration.");
    return;
  }

  pi.registerProvider("litellm", {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: config.api as any,
    models: models.map((m) => {
      const meta = modelMeta(m.id);
      return {
        id: m.id,
        name: displayName(m.id),
        reasoning: meta.reasoning,
        thinkingLevelMap: meta.thinkingLevelMap,
        input: ["text", "image"] as ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
      };
    }),
  });

  console.log(
    `[litellm-sync] Registered ${models.length} model(s): ${models.map((m) => m.id).join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Extension entry point (async factory — pi awaits before session_start)
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  await syncModels(pi);

  // Re-sync on /reload so the selector stays fresh without restarting pi
  pi.on("session_start", async (event) => {
    if (event.reason === "reload") {
      await syncModels(pi);
    }
  });
}
