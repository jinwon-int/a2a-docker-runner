#!/usr/bin/env node
/**
 * tag-release-candidate – Release-candidate tagging gate for a2a-docker-runner.
 *
 * Parent: a2a-docker-runner#195
 * Schema: a2a.runner.tag-release-candidate.v1
 *
 * Runs pre-tag gates and creates an annotated RC tag when they all pass.
 * Tags follow the pattern v<version>-rc<N> where N is the next RC number.
 *
 * Usage:
 *   node scripts/tag-release-candidate.mjs --version 0.1.0
 *   node scripts/tag-release-candidate.mjs --version 0.1.0 --dry-run
 *   node scripts/tag-release-candidate.mjs --version 0.1.0 --message "Round 5 canary pass"
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, "..");
const GUARD_SCRIPT = resolve(__dirname, "pre-pr-bootstrap-guard.mjs");

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    "Usage: node scripts/tag-release-candidate.mjs --version <semver> [--dry-run] [--message <msg>]\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--version") args.version = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--message") args.message = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.version) usage();
  return args;
}

function validateVersion(version) {
  // Accept bare semver like 0.1.0 (the "v" prefix is added for the tag name).
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    throw new Error(`invalid semver: ${version}`);
  }
  return version;
}

/** Compute the next RC number by listing existing v<version>-rc* tags. */
function nextRcTag(version) {
  const raw = execFileSync("git", ["tag", "--list", `v${version}-rc*`], {
    cwd: REPO_DIR,
    encoding: "utf8",
  }).trim();
  if (!raw) return `v${version}-rc1`;
  const tags = raw.split("\n").filter(Boolean);
  const numbers = tags
    .map((t) => {
      const match = t.match(/-rc(\d+)$/);
      return match ? Number(match[1]) : 0;
    })
    .filter((n) => n > 0);
  return `v${version}-rc${Math.max(0, ...numbers) + 1}`;
}

/** Run a shell command in REPO_DIR and return trimmed stdout, or throw on failure. */
function run(command, label) {
  try {
    const result = execFileSync("sh", ["-lc", command], {
      cwd: REPO_DIR,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.trim(), label };
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: stderr.slice(0, 2000), label };
  }
}

/** Gate: working tree must be clean. */
function gateCleanTree() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_DIR,
    encoding: "utf8",
  }).trim();
  if (status) {
    return { ok: false, reason: "working tree is not clean", dirty: status.split("\n").slice(0, 20) };
  }
  return { ok: true };
}

/** Gate: pre-pr-bootstrap-guard must pass. */
function gateBootstrapGuard() {
  try {
    execFileSync(process.execPath, [GUARD_SCRIPT, "--repo-dir", REPO_DIR], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ok: true };
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `bootstrap guard failed: ${stderr.slice(0, 1000)}` };
  }
}

/** Gate: npm build + check + lint. */
function gateNpmCi(version) {
  const checks = [
    run("npm ci 2>&1", "npm ci"),
    run("npm run check 2>&1", "npm run check"),
    run("npm run build 2>&1", "npm run build"),
    run("npm run lint 2>&1", "npm run lint"),
    run("npm test 2>&1", "npm test"),
  ];

  const failures = checks.filter((c) => !c.ok);
  if (failures.length) {
    const details = failures.map((f) => `${f.label}: ${f.stderr || f.stdout}`).join("\n");
    return { ok: false, reason: "npm gates failed", details: details.slice(0, 3000) };
  }
  return { ok: true };
}

/** Gate: chaos E2E mock must pass. */
function gateChaosE2e() {
  return run("npm run chaos:e2e 2>&1", "chaos:e2e mock");
}

/** Gate: package.json version must match --version. */
function gatePkgVersion(expectedVersion) {
  const pkg = JSON.parse(readFileSync(resolve(REPO_DIR, "package.json"), "utf8"));
  if (pkg.version !== expectedVersion) {
    return {
      ok: false,
      reason: `package.json version ${pkg.version} does not match --version ${expectedVersion}`,
    };
  }
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = validateVersion(args.version);

  const gates = [
    { name: "clean-tree", result: gateCleanTree() },
    { name: "pkg-version", result: gatePkgVersion(version) },
    { name: "bootstrap-guard", result: gateBootstrapGuard() },
    { name: "npm-gates", result: gateNpmCi(version) },
    { name: "chaos-e2e-mock", result: gateChaosE2e() },
  ];

  const failed = gates.filter((g) => !g.result.ok);
  const tagName = nextRcTag(version);

  const output = {
    schemaVersion: "a2a.runner.tag-release-candidate.v1",
    ok: failed.length === 0,
    version,
    tagName,
    dryRun: Boolean(args.dryRun),
    parent: "a2a-docker-runner#195",
    gates: gates.map((g) => ({ name: g.name, ...g.result })),
  };

  if (!output.ok) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  }

  if (args.dryRun) {
    output.tagCreated = false;
    output.dryRunNote = `would create tag ${tagName}`;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(0);
  }

  // Create the annotated tag.
  const message = args.message || `Release candidate ${tagName}`;
  try {
    execFileSync("git", ["tag", "-a", tagName, "-m", message], {
      cwd: REPO_DIR,
      encoding: "utf8",
    });
    output.tagCreated = true;
    output.message = message;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    output.tagCreated = false;
    output.error = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
