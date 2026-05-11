import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: Array<{ id: string; compat?: unknown; cost?: unknown }>;
  oauth?: unknown;
};

type TestCommand = {
  description: string;
  handler: (args: string[], ctx: { ui: { notify: (message: string, type: string) => void } }) => Promise<void> | void;
};

type TestPi = {
  providers: Array<{ name: string; config: TestProviderConfig }>;
  commands: Map<string, TestCommand>;
  handlers: Map<string, Array<(event: unknown) => Promise<void> | void>>;
  registerProvider(name: string, config: TestProviderConfig): void;
  registerCommand(name: string, command: TestCommand): void;
  on(event: string, handler: (event: unknown) => Promise<void> | void): void;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createPi(): TestPi {
  return {
    providers: [],
    commands: new Map(),
    handlers: new Map(),
    registerProvider(name, config) {
      this.providers.push({ name, config });
    },
    registerCommand(name, command) {
      this.commands.set(name, command);
    },
    on(event, handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    },
  };
}

async function loadExtension(agentDir: string): Promise<(pi: TestPi) => Promise<void>> {
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    getAgentDir: () => agentDir,
  }));
  const mod = await import("../extensions/litellm-sync.ts");
  return mod.default as unknown as (pi: TestPi) => Promise<void>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("@earendil-works/pi-coding-agent");
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
  delete process.env.LITELLM_DISCOVERY_TIMEOUT_MS;
  delete process.env.LITELLM_OFFLINE;
});

describe("litellm-sync extension", () => {
  it("registers a LiteLLM provider from /model/info metadata", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-litellm-"));
    process.env.LITELLM_BASE_URL = "https://litellm.example.com/v1";
    process.env.LITELLM_API_KEY = "env-key";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/model/info")) {
        return jsonResponse(200, {
          data: [{ model_name: "sonnet-4.6", model_info: { mode: "chat", input_cost_per_token: 0.000003 } }],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const extension = await loadExtension(agentDir);
    const pi = createPi();
    await extension(pi);

    expect(pi.providers).toHaveLength(1);
    expect(pi.providers[0]).toMatchObject({
      name: "litellm",
      config: {
        baseUrl: "https://litellm.example.com/v1",
        apiKey: "LITELLM_API_KEY",
        api: "openai-completions",
        models: [{ id: "sonnet-4.6", compat: { supportsStore: false, cacheControlFormat: "anthropic" } }],
      },
    });
    expect(pi.commands.has("litellm-refresh")).toBe(true);
  });
});
