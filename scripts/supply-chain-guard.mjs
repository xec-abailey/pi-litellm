#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const dangerousLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "pack",
  "postpack",
  "publish",
  "postpublish",
]);

const forbiddenDependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
];

const riskySpecPrefixes = [
  "git:",
  "git+",
  "github:",
  "gitlab:",
  "bitbucket:",
  "http:",
  "https:",
  "file:",
  "link:",
  "workspace:",
  "npm:",
];

const suspiciousFilenames = new Set([
  "router_init.js",
  "router_runtime.js",
  "tanstack_runner.js",
  "setup.mjs",
  "execution.js",
]);

const suspiciousMarkers = [
  "router_init.js",
  "router_runtime.js",
  "tanstack_runner.js",
  "@tanstack/setup",
  "github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c",
  "bun run tanstack_runner.js",
  "A Mini Shai-Hulud has Appeared",
];

const requiredNpmIgnoreEntries = [
  "node_modules/",
  ".git/",
  ".github/",
  "tests/",
  "scripts/supply-chain-guard.mjs",
  ".env",
  ".npmrc",
  "*.tgz",
];

const allowedPackageFiles = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE(?:\..*)?$/,
  /^extensions\/[^/]+\.ts$/,
  /^scripts\/dev\.sh$/,
];

function parseArgs(argv) {
  const parsed = { root: process.cwd() };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      parsed.root = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.root = resolve(parsed.root);
  return parsed;
}

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    errors.push(`${path}: could not parse JSON (${error.message})`);
    return undefined;
  }
}

function hasRiskySpec(spec) {
  const normalized = String(spec).trim().toLowerCase();
  return riskySpecPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function checkManifest(root, pkg, errors) {
  const scripts = pkg.scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (dangerousLifecycleScripts.has(name)) {
      errors.push(
        `package.json: script "${name}" is not allowed; npm lifecycle hooks can run in install or publish contexts`
      );
    }

    for (const marker of suspiciousMarkers) {
      if (String(command).includes(marker)) {
        errors.push(`package.json: script "${name}" contains suspicious marker "${marker}"`);
      }
    }
  }

  for (const section of forbiddenDependencySections) {
    const value = pkg[section];
    if (!value) continue;

    const names = Array.isArray(value) ? value : Object.keys(value);
    if (names.length > 0) {
      errors.push(
        `package.json: ${section} are not allowed in this no-runtime-dependency package (${names.join(", ")})`
      );
    }

    if (!Array.isArray(value)) {
      for (const [name, spec] of Object.entries(value)) {
        if (hasRiskySpec(spec)) {
          errors.push(`package.json: ${section}.${name} uses non-registry spec "${spec}"`);
        }
      }
    }
  }

  for (const [section, value] of Object.entries(pkg)) {
    if (!section.endsWith("Dependencies") || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    for (const [name, spec] of Object.entries(value)) {
      if (name === "@tanstack/setup") {
        errors.push(`package.json: ${section}.${name} matches a known campaign package name`);
      }
      if (hasRiskySpec(spec)) {
        errors.push(`package.json: ${section}.${name} uses non-registry spec "${spec}"`);
      }
    }
  }

  if (!existsSync(join(root, "package-lock.json"))) {
    errors.push("package-lock.json: required so npm audit and CI installs are reproducible");
  }
}

function checkNpmIgnore(root, errors) {
  const npmIgnorePath = join(root, ".npmignore");
  if (!existsSync(npmIgnorePath)) {
    errors.push(".npmignore: required to control npm package contents explicitly");
    return;
  }

  const entries = readFileSync(npmIgnorePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const required of requiredNpmIgnoreEntries) {
    if (!entries.includes(required)) {
      errors.push(`.npmignore: missing required entry "${required}"`);
    }
  }
}

function getPackFiles(root, errors) {
  try {
    const stdout = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const pack = JSON.parse(stdout);
    return pack.flatMap((entry) => entry.files?.map((file) => file.path) ?? []);
  } catch (error) {
    errors.push(`npm pack --dry-run --ignore-scripts failed: ${error.message}`);
    return [];
  }
}

function checkPackageContents(root, files, errors) {
  for (const file of files) {
    if (!allowedPackageFiles.some((pattern) => pattern.test(file))) {
      errors.push(`npm package: unexpected packaged file "${file}"`);
    }

    if (suspiciousFilenames.has(basename(file))) {
      errors.push(`npm package: suspicious payload filename "${file}"`);
    }

    const path = join(root, file);
    let content;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    for (const marker of suspiciousMarkers) {
      if (content.includes(marker)) {
        errors.push(`npm package: "${file}" contains suspicious marker "${marker}"`);
      }
    }
  }
}

function main() {
  const errors = [];
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const packageJsonPath = join(args.root, "package.json");
  if (!existsSync(packageJsonPath)) {
    console.error(`${packageJsonPath}: package.json not found`);
    process.exit(2);
  }

  const pkg = readJson(packageJsonPath, errors);
  if (pkg) {
    checkManifest(args.root, pkg, errors);
  }
  checkNpmIgnore(args.root, errors);
  const packFiles = getPackFiles(args.root, errors);
  checkPackageContents(args.root, packFiles, errors);

  if (errors.length > 0) {
    console.error("Supply-chain guard failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Supply-chain guard passed (${packFiles.length} package files checked).`);
}

main();
