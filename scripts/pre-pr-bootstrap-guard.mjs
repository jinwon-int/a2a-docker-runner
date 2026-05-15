#!/usr/bin/env node
/**
 * pre-pr-bootstrap-guard – Fail closed when OpenClaw runtime/bootstrap context
 * files would be included in repository branch changes.
 *
 * Parent: a2a-broker#446
 * Schema: a2a.runner.pre-pr-bootstrap-guard.v1
 *
 * Usage:
 *   node scripts/pre-pr-bootstrap-guard.mjs --repo-dir /path/to/repo
 */

import { existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const BANNED_FILES = new Set([
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
]);

const BANNED_DIRS = new Set([
  ".openclaw",
  "memory",
]);

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    "Usage: node scripts/pre-pr-bootstrap-guard.mjs --repo-dir <path> [--artifacts-dir <path>]\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--repo-dir") args.repoDir = argv[++i];
    else if (arg === "--artifacts-dir") args.artifactsDir = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.repoDir) usage();
  return args;
}

/**
 * Recursively walk a directory for banned bootstrap paths.
 * Returns a sorted list of repo-relative offending paths.
 */
async function collectBannedPaths(repoDir, artifactsDir) {
  const absolute = resolve(repoDir);
  const candidates = [];

  // Check top-level banned files.
  for (const name of BANNED_FILES) {
    const full = join(absolute, name);
    if (existsSync(full)) candidates.push(name);
  }

  // Check top-level banned directories.
  for (const name of BANNED_DIRS) {
    const full = join(absolute, name);
    if (existsSync(full)) {
      const entries = await walkDir(full, name);
      for (const entry of entries) candidates.push(entry);
      if (entries.length === 0) candidates.push(name); // empty dir
    }
  }

  const offending = filterBranchEnteringPaths(absolute, candidates);
  if (artifactsDir) {
    offending.push(...await collectBannedArtifactPaths(artifactsDir));
  }
  offending.sort();
  return offending;
}

/**
 * Artifact evidence is always publishable evidence, so any runtime/bootstrap
 * context copied there must fail closed.  Report stable artifact-relative paths
 * only; never include absolute host/container paths.
 */
async function collectBannedArtifactPaths(artifactsDir) {
  const absolute = resolve(artifactsDir);
  const candidates = [];

  for (const name of BANNED_FILES) {
    const full = join(absolute, name);
    if (existsSync(full)) candidates.push(`artifacts/${name}`);
  }

  for (const name of BANNED_DIRS) {
    const full = join(absolute, name);
    if (existsSync(full)) {
      const entries = await walkDir(full, `artifacts/${name}`);
      candidates.push(...entries);
      if (entries.length === 0) candidates.push(`artifacts/${name}`);
    }
  }

  return candidates;
}

function filterBranchEnteringPaths(repoDir, candidates) {
  if (candidates.length === 0) return [];

  // If this is not a Git checkout or Git is unavailable, fail closed and report
  // every discovered runtime/bootstrap path. Inside normal runner checkouts,
  // ignored untracked files are safe because broad `git add -A` will not stage
  // them; tracked, staged, modified, or unignored untracked files are not safe.
  if (!isGitWorkTree(repoDir)) return [...candidates];

  return candidates.filter((candidate) => {
    const tracked = gitOutput(repoDir, ["ls-files", "--", candidate]);
    if (tracked === undefined || tracked.trim()) return true;

    const pending = gitOutput(repoDir, ["status", "--porcelain", "--", candidate]);
    if (pending === undefined) return true;
    return pending.trim().length > 0;
  });
}

function isGitWorkTree(repoDir) {
  const result = spawnSync("git", ["-C", repoDir, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function gitOutput(repoDir, args) {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout : undefined;
}

async function walkDir(dir, prefix) {
  const entries = [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of dirents) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const children = await walkDir(join(dir, entry.name), rel);
      entries.push(...children);
      if (children.length === 0) entries.push(rel); // empty dir
    } else {
      entries.push(rel);
    }
  }
  return entries;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const absolute = resolve(args.repoDir);

  const offending = await collectBannedPaths(absolute, args.artifactsDir);

  const output = {
    schemaVersion: "a2a.runner.pre-pr-bootstrap-guard.v1",
    ok: offending.length === 0,
    // Keep guard evidence source-public: report offending paths relative to the
    // checkout, never host-specific absolute repository paths.
    repo: ".",
    parent: "a2a-broker#446",
    ...(offending.length ? { offendingPaths: offending } : {}),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (!output.ok) {
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
