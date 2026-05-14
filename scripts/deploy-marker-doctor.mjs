#!/usr/bin/env node
/**
 * deploy-marker-doctor – No-live deploy-marker validation and refresh safety evidence.
 *
 * Schema: a2a.runner.deploy-marker-doctor.v1
 *
 * Validates that the deployed runner revision matches a specified deploy marker
 * and produces structured no-live refresh safety evidence. All checks are
 * deterministic and touch no live services, no production state, and no external
 * provider endpoints.
 *
 * Usage:
 *   node scripts/deploy-marker-doctor.mjs --expected-revision <sha>
 *   node scripts/deploy-marker-doctor.mjs --expected-revision <sha> --repo-dir /path/to/repo
 *
 * Options:
 *   --expected-revision   Deploy marker (full 40-char SHA or short 12-char SHA)
 *   --repo-dir            Path to the runner repository checkout (default: cwd)
 *   --no-live             Explicit no-live mode (default: true)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    "Usage: node scripts/deploy-marker-doctor.mjs --expected-revision <sha> [--repo-dir <path>] [--no-live]\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { noLive: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--expected-revision") args.expectedRevision = argv[++i];
    else if (arg === "--repo-dir") args.repoDir = resolve(argv[++i]);
    else if (arg === "--no-live") args.noLive = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.expectedRevision || !/^[0-9a-f]{12,40}$/i.test(args.expectedRevision)) {
    throw new Error("--expected-revision is required and must be a git SHA (12-40 hex chars)");
  }
  return args;
}

/**
 * Run a shell command and return stdout, or throw on failure.
 */
function run(command, cwd, label) {
  try {
    const result = execFileSync("sh", ["-lc", command], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.trim(), label };
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: stderr.slice(0, 2000), label };
  }
}

/**
 * Check: is this a git checkout?
 */
function checkGitCheckout(repoDir) {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 5000,
    });
    const isWorkTree = result.trim() === "true";
    return { ok: isWorkTree, message: isWorkTree ? "inside a git checkout" : "not a git checkout" };
  } catch {
    return { ok: false, message: "git rev-parse failed: not a git checkout" };
  }
}

/**
 * Check: get the current local revision and compare against the expected marker.
 */
function checkRevision(repoDir, expectedRevision) {
  const gitCheck = checkGitCheckout(repoDir);
  if (!gitCheck.ok) {
    return { ok: false, localSha: null, fullLocalSha: null, message: gitCheck.message };
  }

  try {
    const fullSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 5000,
    }).trim().toLowerCase();

    const shortSha = fullSha.slice(0, 12);
    const marker = expectedRevision.toLowerCase();
    const matches = fullSha === marker || shortSha === marker;

    return {
      ok: matches,
      localSha: shortSha,
      fullLocalSha: fullSha,
      expectedSha: marker,
      message: matches
        ? "deployed revision matches deploy marker"
        : `deployed revision ${shortSha} does not match expected marker ${marker.slice(0, 12)}`,
    };
  } catch (error) {
    return {
      ok: false,
      localSha: null,
      fullLocalSha: null,
      message: `failed to get local revision: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check: read package.json version.
 */
function checkRunnerVersion(repoDir) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoDir, "package.json"), "utf8"));
    return { ok: Boolean(pkg.version), version: pkg.version || "unknown" };
  } catch {
    return { ok: false, version: "unknown" };
  }
}

/**
 * Check: working tree cleanliness.
 */
function checkWorkingTree(repoDir) {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return { ok: porcelain.length === 0, dirty: porcelain.length > 0, dirtyFiles: porcelain.length > 0 ? porcelain.split("\n").length : 0 };
  } catch {
    return { ok: false, dirty: true, dirtyFiles: null };
  }
}

/**
 * Run all no-live deploy-marker doctor checks.
 */
function runChecks(repoDir, expectedRevision) {
  const runnerVersion = checkRunnerVersion(repoDir);
  const revision = checkRevision(repoDir, expectedRevision);
  const workingTree = checkWorkingTree(repoDir);

  return {
    runnerVersion,
    revision,
    workingTree,
    ok: revision.ok,
    noLiveProviderSend: true,
    terminalAckPerformed: false,
    deployOrRestartPerformed: false,
    dbMutationPerformed: false,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = args.repoDir || process.cwd();

  if (!existsSync(resolve(repoDir, "package.json"))) {
    const output = {
      schemaVersion: "a2a.runner.deploy-marker-doctor.v1",
      ok: false,
      expectedRevision: args.expectedRevision,
      noLive: args.noLive,
      error: `no package.json found at ${repoDir} — not a runner checkout`,
      checks: {
        runnerVersion: { ok: false, version: "unknown" },
        revision: { ok: false, localSha: null },
        workingTree: { ok: false },
      },
      safetyGates: {
        noLiveProviderSend: true,
        terminalAckPerformed: false,
        deployOrRestartPerformed: false,
        dbMutationPerformed: false,
      },
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    process.exit(1);
  }

  const checks = runChecks(repoDir, args.expectedRevision);
  const branch = (() => {
    try {
      const b = execFileSync("git", ["branch", "--show-current"], {
        cwd: repoDir,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      return b || "detached";
    } catch {
      return "unknown";
    }
  })();

  const output = {
    schemaVersion: "a2a.runner.deploy-marker-doctor.v1",
    ok: checks.ok,
    expectedRevision: args.expectedRevision,
    currentRevision: checks.revision.fullLocalSha,
    branch,
    runnerVersion: checks.runnerVersion.version,
    noLive: args.noLive,
    checks: {
      runnerVersion: {
        ok: checks.runnerVersion.ok,
        version: checks.runnerVersion.version,
      },
      revision: {
        ok: checks.revision.ok,
        localSha: checks.revision.localSha,
        fullLocalSha: checks.revision.fullLocalSha,
        expectedSha: checks.revision.expectedSha,
      },
      workingTree: {
        ok: checks.workingTree.ok,
        dirty: checks.workingTree.dirty,
        dirtyFiles: checks.workingTree.dirtyFiles,
      },
    },
    safetyGates: {
      noLiveProviderSend: checks.noLiveProviderSend,
      terminalAckPerformed: checks.terminalAckPerformed,
      deployOrRestartPerformed: checks.deployOrRestartPerformed,
      dbMutationPerformed: checks.dbMutationPerformed,
    },
    summary: checks.ok
      ? `deploy marker verified: ${args.expectedRevision.slice(0, 12)} matches deployed revision`
      : `deploy marker mismatch: expected ${args.expectedRevision.slice(0, 12)}, got ${checks.revision.localSha || "unknown"}`,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.exit(output.ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  const output = {
    schemaVersion: "a2a.runner.deploy-marker-doctor.v1",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    noLive: true,
    safetyGates: {
      noLiveProviderSend: true,
      terminalAckPerformed: false,
      deployOrRestartPerformed: false,
      dbMutationPerformed: false,
    },
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.exit(2);
}
