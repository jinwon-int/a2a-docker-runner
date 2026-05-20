/**
 * Tests for OpenClaw profile CLI mount readiness smoke.
 *
 * Covers:
 * - Happy path: all checks pass (CLI resolved, version ok, mount present).
 * - CLI unavailable: binary not on PATH.
 * - Profile mount missing: directory absent.
 * - Version probe failure: binary exists but --version fails.
 * - Combined failures: multiple checks fail.
 * - No bootstrap leaks or secrets in any check detail.
 * - Deterministic output for same inputs.
 *
 * Parent: a2a-docker-runner#297
 * Parent: a2a-broker#829
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROFILE_MOUNT_PATH,
  validateOpenClawProfileReadiness,
  buildExampleReadinessInput,
} from "./openclaw-profile-readiness.js";
import type {
  OpenClawProfileReadinessInput,
  OpenClawProfileReadinessOutcome,
  OpenClawReadinessFailureCategory,
} from "./openclaw-profile-readiness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test("all checks pass for a fully configured worker", () => {
  const input = buildExampleReadinessInput();
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, true);
  assert.equal(result.failureCategory, "ok");
  assert.equal(result.checks.length, 3);

  for (const check of result.checks) {
    assert.equal(check.passed, true, `check "${check.kind}" should pass`);
  }

  assert.ok(result.summary.startsWith("OpenClaw profile readiness: OK"));
  assert.ok(result.summary.includes("category=ok"));
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI unavailable
// ─────────────────────────────────────────────────────────────────────────────

test("fails when CLI binary is not on PATH", () => {
  const input = buildExampleReadinessInput({
    cliOnPath: false,
    cliPath: undefined,
    cliVersionOk: false,
    cliVersion: undefined,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureCategory, "openclaw_cli_unavailable");
  assert.equal(result.checks[0].passed, false);
  assert.equal(result.checks[0].kind, "openclaw_cli_resolved");
  assert.ok(result.summary.includes("category=openclaw_cli_unavailable"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile mount missing
// ─────────────────────────────────────────────────────────────────────────────

test("fails when profile config mount directory is absent", () => {
  const input = buildExampleReadinessInput({
    profileMountExists: false,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureCategory, "openclaw_profile_unavailable");

  const mountCheck = result.checks.find((c) => c.kind === "openclaw_profile_mount_present");
  assert.ok(mountCheck, "should have a mount presence check");
  assert.equal(mountCheck?.passed, false);
  assert.ok(mountCheck?.detail.includes(DEFAULT_PROFILE_MOUNT_PATH));
  assert.ok(result.summary.includes("category=openclaw_profile_unavailable"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Version probe failure
// ─────────────────────────────────────────────────────────────────────────────

test("fails with version_failed when CLI exists but --version fails", () => {
  const input = buildExampleReadinessInput({
    cliVersionOk: false,
    cliVersion: undefined,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureCategory, "openclaw_version_failed");

  const versionCheck = result.checks.find((c) => c.kind === "openclaw_cli_version_ok");
  assert.ok(versionCheck, "should have a version check");
  assert.equal(versionCheck?.passed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined failures
// ─────────────────────────────────────────────────────────────────────────────

test("CLI unavailable takes priority when both CLI and mount are missing", () => {
  const input = buildExampleReadinessInput({
    cliOnPath: false,
    cliPath: undefined,
    cliVersionOk: false,
    cliVersion: undefined,
    profileMountExists: false,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureCategory, "openclaw_cli_unavailable");
  assert.equal(result.checks.filter((c) => c.passed).length, 0);
});

test("profile_unavailable is the category when only mount is missing", () => {
  const input = buildExampleReadinessInput({
    cliOnPath: true,
    cliPath: "/usr/local/bin/openclaw",
    cliVersionOk: true,
    cliVersion: "openclaw 1.0.0",
    profileMountExists: false,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureCategory, "openclaw_profile_unavailable");
  // CLI checks should pass
  assert.equal(result.checks[0].passed, true);
  assert.equal(result.checks[1].passed, true);
  // Mount check should fail
  assert.equal(result.checks[2].passed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom mount path
// ─────────────────────────────────────────────────────────────────────────────

test("accepts a custom expected mount path", () => {
  const customPath = "/secure/operator/openclaw-config";
  const input = buildExampleReadinessInput({
    expectedMountPath: customPath,
    profileMountExists: true,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, true);

  const mountCheck = result.checks.find((c) => c.kind === "openclaw_profile_mount_present");
  assert.ok(mountCheck?.detail.includes(customPath));
});

test("reports missing custom mount path correctly", () => {
  const customPath = "/custom/mount/path";
  const input = buildExampleReadinessInput({
    expectedMountPath: customPath,
    profileMountExists: false,
  });
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.failureCategory, "openclaw_profile_unavailable");

  const mountCheck = result.checks.find((c) => c.kind === "openclaw_profile_mount_present");
  assert.ok(mountCheck?.detail.includes(customPath));
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

test("same inputs produce identical outputs", () => {
  const input = buildExampleReadinessInput();
  const first = validateOpenClawProfileReadiness(input);
  const second = validateOpenClawProfileReadiness(input);

  assert.deepEqual(first, second);
});

test("different inputs produce different failures deterministically", () => {
  const okInput = buildExampleReadinessInput();
  const failInput = buildExampleReadinessInput({ cliOnPath: false });

  const okResult = validateOpenClawProfileReadiness(okInput);
  const failResult = validateOpenClawProfileReadiness(failInput);

  assert.equal(okResult.ok, true);
  assert.equal(failResult.ok, false);
  assert.notDeepEqual(okResult, failResult);
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety: no secrets, no bootstrap leaks
// ─────────────────────────────────────────────────────────────────────────────

test("check details do not contain GitHub tokens or secrets", () => {
  const inputs: OpenClawProfileReadinessInput[] = [
    buildExampleReadinessInput(),
    buildExampleReadinessInput({ cliOnPath: false, cliPath: undefined }),
    buildExampleReadinessInput({ profileMountExists: false }),
    buildExampleReadinessInput({ errors: ["some diagnostic message"] }),
  ];

  for (const input of inputs) {
    const result = validateOpenClawProfileReadiness(input);
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      "ghp_",
      "github_pat_",
      "x-access-token",
      "sk-",
      "xai-",
      "password",
      "secret:",
      "AGENTS.md",
      "SOUL.md",
      "USER.md",
      "TOOLS.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
      ".openclaw/",
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `${input.errors.length > 0 ? "with errors" : "clean input"}: detail contains forbidden value: ${forbidden}`,
      );
    }
  }
});

test("no check detail exposes credential values", () => {
  const result = validateOpenClawProfileReadiness(buildExampleReadinessInput());

  for (const check of result.checks) {
    assert.ok(!check.detail.includes("/root/"), `check "${check.kind}" detail should not contain /root/`);
    assert.ok(!check.detail.includes("/home/"), `check "${check.kind}" detail should not contain /home/`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded output
// ─────────────────────────────────────────────────────────────────────────────

test("summary is bounded (under 500 chars)", () => {
  const result = validateOpenClawProfileReadiness(buildExampleReadinessInput());
  assert.ok(result.summary.length <= 500, `summary too long: ${result.summary.length} chars`);

  const failResult = validateOpenClawProfileReadiness(
    buildExampleReadinessInput({ cliOnPath: false, profileMountExists: false }),
  );
  assert.ok(failResult.summary.length <= 500, `fail summary too long: ${failResult.summary.length} chars`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge: errors array handling
// ─────────────────────────────────────────────────────────────────────────────

test("errors from input are not included in outcome without explicit collect", () => {
  // The validate function does not automatically merge input.errors.
  // This is intentional — the caller controls error propagation.
  const input = buildExampleReadinessInput({ errors: ["probe timeout"] });
  const result = validateOpenClawProfileReadiness(input);

  // validateOpenClawProfileReadiness itself doesn't inject input.errors into
  // checks or summary; it only uses them for its own derived logic.
  // This test confirms the boundary.
  assert.equal(result.ok, true);
  assert.equal(result.failureCategory, "ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure category type exhaustiveness
// ─────────────────────────────────────────────────────────────────────────────

test("failureCategory is always one of the known values", () => {
  const categories: OpenClawReadinessFailureCategory[] = [
    "ok",
    "openclaw_cli_unavailable",
    "openclaw_profile_unavailable",
    "openclaw_version_failed",
  ];

  const inputs: OpenClawProfileReadinessInput[] = [
    buildExampleReadinessInput(),
    buildExampleReadinessInput({ cliOnPath: false }),
    buildExampleReadinessInput({ profileMountExists: false }),
    buildExampleReadinessInput({ cliVersionOk: false }),
    buildExampleReadinessInput({ cliOnPath: false, profileMountExists: false }),
  ];

  for (const input of inputs) {
    const result = validateOpenClawProfileReadiness(input);
    assert.ok(
      categories.includes(result.failureCategory),
      `unexpected failure category: ${result.failureCategory}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// buildExampleReadinessInput
// ─────────────────────────────────────────────────────────────────────────────

test("buildExampleReadinessInput produces valid all-pass input by default", () => {
  const input = buildExampleReadinessInput();
  const result = validateOpenClawProfileReadiness(input);

  assert.equal(result.ok, true);
  assert.equal(input.expectedMountPath, DEFAULT_PROFILE_MOUNT_PATH);
});

test("buildExampleReadinessInput merges overrides correctly", () => {
  const input = buildExampleReadinessInput({
    cliPath: "/opt/bin/openclaw",
    cliVersion: "0.9.0",
  });

  assert.equal(input.cliPath, "/opt/bin/openclaw");
  assert.equal(input.cliVersion, "0.9.0");
  // Unchanged defaults
  assert.equal(input.cliOnPath, true);
  assert.equal(input.profileMountExists, true);
});
