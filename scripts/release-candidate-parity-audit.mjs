#!/usr/bin/env node
/**
 * release-candidate-parity-audit – deterministic, CI-safe release parity checks.
 *
 * This audit is intentionally read-only. It verifies that final release-candidate
 * evidence still covers the runner gates operators rely on before rollout:
 * type/build/test/lint gates, the pre-PR OpenClaw bootstrap guard, chaos E2E
 * evidence, and active/excluded worker rollout parity.
 *
 * Schema: a2a.runner.release-candidate-parity-audit.v1
 */

import { readFileSync } from "node:fs";

const REQUIRED_PACKAGE_SCRIPTS = ["check", "build", "lint", "test", "chaos:e2e"];
const REQUIRED_CI_STEPS = [
  "npm run check",
  "npm run build",
  "npm run lint",
  "npm test",
  "node scripts/pre-pr-bootstrap-guard.mjs --repo-dir .",
];
const REQUIRED_BOOTSTRAP_PATHS = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
  ".openclaw",
  "memory",
];
const ACTIVE_WORKERS = ["bangtong", "dungae", "sogyo", "nosuk"];
const EXCLUDED_WORKERS = ["yukson"];

function readText(path) {
  return readFileSync(path, "utf8");
}

function packageScriptChecks(pkg) {
  return REQUIRED_PACKAGE_SCRIPTS.map((script) => ({
    id: `package-script:${script}`,
    passed: typeof pkg.scripts?.[script] === "string" && pkg.scripts[script].length > 0,
    evidence: `package.json scripts.${script}`,
  }));
}

function containsChecks(text, required, prefix, evidencePath) {
  return required.map((needle) => ({
    id: `${prefix}:${needle}`,
    passed: text.includes(needle),
    evidence: evidencePath,
  }));
}

function workerChecks(text, workers, expectation, evidencePath) {
  return workers.map((worker) => ({
    id: `${expectation}-worker:${worker}`,
    passed: text.includes(worker),
    evidence: evidencePath,
  }));
}

function main() {
  const pkg = JSON.parse(readText("package.json"));
  const ci = readText(".github/workflows/ci.yml");
  const guard = readText("scripts/pre-pr-bootstrap-guard.mjs");
  const rollout = readText("docs/release-rollout-checklist.md");

  const checks = [
    ...packageScriptChecks(pkg),
    ...containsChecks(ci, REQUIRED_CI_STEPS, "ci-step", ".github/workflows/ci.yml"),
    ...containsChecks(guard, REQUIRED_BOOTSTRAP_PATHS, "bootstrap-guard-path", "scripts/pre-pr-bootstrap-guard.mjs"),
    ...containsChecks(rollout, ["npm run chaos:e2e", "node --test dist/canary.test.js", "npm run rollout:receipt-evidence"], "rollout-gate", "docs/release-rollout-checklist.md"),
    ...workerChecks(rollout, ACTIVE_WORKERS, "active", "docs/release-rollout-checklist.md"),
    ...workerChecks(rollout, EXCLUDED_WORKERS, "excluded", "docs/release-rollout-checklist.md"),
  ];

  const failed = checks.filter((check) => !check.passed);
  const output = {
    schemaVersion: "a2a.runner.release-candidate-parity-audit.v1",
    ok: failed.length === 0,
    sourcePublicExecution: "not_performed",
    liveProviderSendPerformed: false,
    terminalAckSent: false,
    dbMutationPerformed: false,
    deployOrRestartPerformed: false,
    activeWorkers: ACTIVE_WORKERS,
    excludedWorkers: EXCLUDED_WORKERS,
    bootstrapGuardBannedPaths: REQUIRED_BOOTSTRAP_PATHS,
    checkedFiles: [
      "package.json",
      ".github/workflows/ci.yml",
      "scripts/pre-pr-bootstrap-guard.mjs",
      "docs/release-rollout-checklist.md",
    ],
    checks,
    failures: failed.map(({ id, evidence }) => ({ id, evidence })),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(output.ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  const output = {
    schemaVersion: "a2a.runner.release-candidate-parity-audit.v1",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(2);
}
