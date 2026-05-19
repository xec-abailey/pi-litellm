import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = new URL("..", import.meta.url).pathname;
const guard = join(repoRoot, "scripts", "supply-chain-guard.mjs");

function runGuard(args = [], options = {}) {
  return spawnSync(process.execPath, [guard, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    ...options,
  });
}

test("rejects the Mini Shai-Hulud dependency and lifecycle pattern", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-litellm-guard-"));
  try {
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify(
        {
          name: "malicious-fixture",
          version: "1.0.0",
          scripts: {
            prepare: "bun run tanstack_runner.js && exit 1",
          },
          optionalDependencies: {
            "@tanstack/setup":
              "github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c",
          },
        },
        null,
        2
      )
    );
    await writeFile(join(fixture, "router_init.js"), "console.log('payload');\n");

    const result = runGuard(["--root", fixture]);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0);
    assert.match(output, /optionalDependencies/);
    assert.match(output, /prepare/);
    assert.match(output, /@tanstack\/setup/);
    assert.match(output, /router_init\.js/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("accepts the current repository manifest and package contents", () => {
  const result = runGuard();
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Supply-chain guard passed/);
});
