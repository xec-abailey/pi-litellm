import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestPi = {
  handlers: Map<string, Array<(event: unknown, ctx: { ui: { notify: (message: string, type: string) => void } }) => Promise<unknown> | unknown>>;
  on(
    event: string,
    handler: (event: unknown, ctx: { ui: { notify: (message: string, type: string) => void } }) => Promise<unknown> | unknown,
  ): void;
};

function createPi(): TestPi {
  return {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    },
  };
}

async function loadExtension(agentDir: string): Promise<(pi: TestPi) => void> {
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    getAgentDir: () => agentDir,
  }));
  const mod = await import("../extensions/litellm-cost.ts");
  return mod.default as unknown as (pi: TestPi) => void;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
});

describe("litellm-cost extension", () => {
  it("normalizes a /v1 base URL before fetching /model/info", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-litellm-"));
    process.env.LITELLM_BASE_URL = "https://litellm.example.com/v1";
    process.env.LITELLM_API_KEY = "env-key";
    const seenUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seenUrls.push(String(input));
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const extension = await loadExtension(agentDir);
    const pi = createPi();
    extension(pi);
    await pi.handlers.get("session_start")?.[0]?.({}, { ui: { notify: vi.fn() } });

    expect(seenUrls).toEqual(["https://litellm.example.com/model/info"]);
  });
});
