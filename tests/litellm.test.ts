import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCompat,
  discoverModels,
  fingerprint,
  normalizeBaseUrl,
  readCache,
  resolveLiteLLMConfig,
  writeCache,
} from "../lib/litellm.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and a trailing /v1 suffix", () => {
    expect(normalizeBaseUrl("https://x.example.com/v1/")).toBe("https://x.example.com");
    expect(normalizeBaseUrl("https://x.example.com///")).toBe("https://x.example.com");
    expect(normalizeBaseUrl("https://x.example.com/proxy/v1")).toBe("https://x.example.com/proxy");
  });
});

describe("buildCompat", () => {
  it("enables Anthropic cache control for prefixed and bare Claude aliases", () => {
    expect(buildCompat("anthropic/claude-3-5-sonnet")).toEqual({
      supportsStore: false,
      cacheControlFormat: "anthropic",
    });
    expect(buildCompat("sonnet-4.6")).toEqual({
      supportsStore: false,
      cacheControlFormat: "anthropic",
    });
    expect(buildCompat("openai/gpt-4o")).toEqual({ supportsStore: false });
  });
});

describe("discoverModels", () => {
  it("uses /model/info metadata before falling back to /v1/models", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/model/info")) {
        return jsonResponse(200, {
          data: [
            {
              model_name: "anthropic/claude-3-5-sonnet",
              model_info: {
                mode: "chat",
                max_input_tokens: 200000,
                max_output_tokens: 8192,
                supports_vision: true,
                supports_reasoning: false,
                input_cost_per_token: 0.000003,
                output_cost_per_token: 0.000015,
                cache_read_input_token_cost: 0.0000003,
                cache_creation_input_token_cost: 0.00000375,
              },
            },
            {
              model_name: "openai/text-embedding-3-large",
              model_info: { mode: "embedding" },
            },
          ],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await discoverModels("https://litellm.example.com/v1", "sk-test");

    expect(result.source).toBe("model_info");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      id: "anthropic/claude-3-5-sonnet",
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: { supportsStore: false, cacheControlFormat: "anthropic" },
    });
  });

  it("falls back to /v1/models on auth or missing /model/info", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/model/info")) return new Response(null, { status: 403 });
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "openai/gpt-4o" }, { id: "sonnet-4.6" }] });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await discoverModels("https://litellm.example.com", "sk-test");

    expect(result.source).toBe("models_list");
    expect(result.models.map((model) => model.id)).toEqual(["openai/gpt-4o", "sonnet-4.6"]);
    expect(result.models[1].name).toBe("sonnet-4.6 (no metadata)");
    expect(result.models[1].compat).toEqual({ supportsStore: false, cacheControlFormat: "anthropic" });
  });
});

describe("cache helpers", () => {
  it("round-trips valid cache files and fingerprints keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-litellm-"));
    const cache = {
      baseUrl: "https://litellm.example.com",
      apiKeyFingerprint: fingerprint("sk-test"),
      fetchedAt: 123,
      source: "model_info" as const,
      models: [],
    };

    await writeCache(join(dir, "cache.json"), cache);

    expect(await readCache(join(dir, "cache.json"))).toEqual(cache);
    expect(fingerprint("sk-test")).toHaveLength(64);
  });
});

describe("resolveLiteLLMConfig", () => {
  it("prefers stored auth credentials over env and models.json key", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-litellm-"));
    const modelsPath = join(agentDir, "models.json");
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ litellm: { type: "oauth", access: "stored-key", refresh: "", expires: 999, baseUrl: "https://auth.example.com/v1" } }),
      "utf8",
    );
    await writeFile(
      modelsPath,
      JSON.stringify({ providers: { litellm: { baseUrl: "https://models.example.com", apiKey: "models-key", api: "anthropic-messages" } } }),
      "utf8",
    );
    process.env.LITELLM_BASE_URL = "https://env.example.com";
    process.env.LITELLM_API_KEY = "env-key";

    const config = await resolveLiteLLMConfig({ agentDir, modelsJsonPath: modelsPath });

    expect(config).toMatchObject({
      baseUrl: "https://auth.example.com",
      apiKey: "stored-key",
      providerApiKey: "LITELLM_API_KEY",
      api: "anthropic-messages",
    });
  });
});
