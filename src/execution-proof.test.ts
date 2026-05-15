// ─────────────────────────────────────────────────────────────────────────────
// Execution Proof Tests (Team1 nosuk lane, A2A R23)
// Parent: a2a-docker-runner#261
// ─────────────────────────────────────────────────────────────────────────────

import test from "node:test";
import assert from "node:assert/strict";
import {
  sha256Json,
  sha256Text,
  buildExecutionProof,
  verifyExecutionProof,
} from "./execution-proof.js";
import type {
  NormalizedRunnerTask,
  RunnerResult,
  RunnerTask,
} from "./types.js";

// ---------------------------------------------------------------------------
// Digest Helpers
// ---------------------------------------------------------------------------

test("sha256Json produces deterministic output for same input", () => {
  const a = sha256Json({ a: 1, b: 2 });
  const b = sha256Json({ b: 2, a: 1 });
  assert.equal(a, b, "Key order must not affect digest");
});

test("sha256Text produces consistent hashes", () => {
  const h1 = sha256Text("hello");
  const h2 = sha256Text("hello");
  assert.equal(h1, h2);
  assert.notEqual(sha256Text("hello"), sha256Text("world"));
});

// ---------------------------------------------------------------------------
// Build Execution Proof
// ---------------------------------------------------------------------------

const BASE_TASK: NormalizedRunnerTask = {
  id: "proof-test-1",
  intent: "propose_patch",
  repos: [],
  commands: ["echo hello"],
};

const BASE_RESULT: RunnerResult = {
  ok: true,
  taskId: "proof-test-1",
  status: "completed",
  workDir: "/tmp/work",
  stdout: "hello\n",
  stderr: "",
  artifacts: [],
};

test("buildExecutionProof produces valid proof for successful task", () => {
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result: BASE_RESULT,
    runToken: "token-abc",
    now: "2025-01-01T00:00:00.000Z",
  });

  assert.equal(proof.schemaVersion, "a2a.runner.execution-proof.v1");
  assert.equal(proof.taskId, "proof-test-1");
  assert.equal(proof.runToken, "token-abc");
  assert.equal(proof.generatedAt, "2025-01-01T00:00:00.000Z");
  assert.equal(proof.ok, true);
  assert.equal(proof.status, "completed");
  assert.equal(proof.exitCode, null);
  assert.ok(proof.inputDigest.length > 0);
  assert.ok(proof.expandedDigest.length > 0);
  assert.ok(proof.outputDigest.length > 0);
  assert.ok(proof.chainDigest.length > 0);
  assert.equal(proof.inputDigest, proof.expandedDigest); // no expansion
});

test("buildExecutionProof includes PR URL when present", () => {
  const result: RunnerResult = {
    ...BASE_RESULT,
    prUrl: "https://github.com/org/repo/pull/42",
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result,
    runToken: "token-abc",
  });
  assert.equal(proof.prUrl, "https://github.com/org/repo/pull/42");
});

test("buildExecutionProof uses expanded digest when expansion occurred", () => {
  const expanded: RunnerTask = {
    id: "proof-test-1",
    intent: "propose_patch",
    commands: ["echo hello expanded"],
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result: BASE_RESULT,
    expanded,
    runToken: "token-xyz",
  });
  assert.notEqual(proof.inputDigest, proof.expandedDigest);
});

test("buildExecutionProof classifies timeout", () => {
  const result: RunnerResult = {
    ...BASE_RESULT,
    ok: false,
    status: "timeout",
    exitCode: null,
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result,
    runToken: "token-timeout",
  });
  assert.equal(proof.ok, false);
  assert.equal(proof.status, "timeout");
  assert.equal(proof.outcome, "timed_out");
  assert.equal(proof.failureCategory, "timeout_exceeded");
});

test("buildExecutionProof classifies infrastructure failure", () => {
  const result: RunnerResult = {
    ...BASE_RESULT,
    ok: false,
    status: "failed",
    error: "ENOENT: docker not found",
    exitCode: null,
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result,
    runToken: "token-infra",
  });
  assert.equal(proof.outcome, "failed_infrastructure");
  assert.equal(proof.failureCategory, "engine_not_found");
});

test("buildExecutionProof classifies OOM failure", () => {
  const result: RunnerResult = {
    ...BASE_RESULT,
    ok: false,
    status: "failed",
    error: "Container OOMKill: memory limit exceeded",
    exitCode: 137,
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result,
    runToken: "token-oom",
  });
  assert.equal(proof.failureCategory, "oom");
});

test("buildExecutionProof classifies image pull failure", () => {
  const result: RunnerResult = {
    ...BASE_RESULT,
    ok: false,
    status: "failed",
    error: "pull access denied for image/path",
    exitCode: 1,
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result,
    runToken: "token-pull",
  });
  assert.equal(proof.failureCategory, "image_pull_failure");
});

test("buildExecutionProof classifies missing evidence", () => {
  const result: RunnerResult = {
    ...BASE_RESULT,
    ok: false,
    status: "failed",
    error: "missing_evidence: no PR created",
    exitCode: 1,
  };
  const proof = buildExecutionProof({
    task: BASE_TASK,
    result,
    runToken: "token-evidence",
  });
  assert.equal(proof.outcome, "missing_evidence");
});

// ---------------------------------------------------------------------------
// Verify Execution Proof
// ---------------------------------------------------------------------------

test("verifyExecutionProof passes for valid proof", () => {
  const task = BASE_TASK;
  const result = { ...BASE_RESULT, stdout: "hello\n", stderr: "" };
  const proof = buildExecutionProof({ task, result, runToken: "verify-1" });

  const verification = verifyExecutionProof(proof, task, undefined, result.stdout, result.stderr);
  assert.ok(verification.valid);
});

test("verifyExecutionProof fails on output digest mismatch", () => {
  const task = BASE_TASK;
  const result = { ...BASE_RESULT, stdout: "hello\n", stderr: "" };
  const proof = buildExecutionProof({ task, result, runToken: "verify-2" });

  const verification = verifyExecutionProof(proof, task, undefined, "tampered output", "");
  assert.equal(verification.valid, false);
  assert.ok(verification.reason.includes("outputDigest mismatch"));
});

test("verifyExecutionProof fails on input digest mismatch", () => {
  const task = BASE_TASK;
  const result = { ...BASE_RESULT, stdout: "hello\n", stderr: "" };
  const proof = buildExecutionProof({ task, result, runToken: "verify-3" });

  const tamperedTask: NormalizedRunnerTask = { ...task, commands: ["echo tampered"] };
  const verification = verifyExecutionProof(proof, tamperedTask, undefined, result.stdout, result.stderr);
  assert.equal(verification.valid, false);
  assert.ok(verification.reason.includes("inputDigest mismatch"));
});

test("verifyExecutionProof detects chain digest break", () => {
  const task = BASE_TASK;
  const result = { ...BASE_RESULT, stdout: "hello\n", stderr: "" };
  const proof = buildExecutionProof({ task, result, runToken: "verify-4" });

  // Tamper the proof directly.
  const tampered = { ...proof, outputDigest: sha256Text("forged") };
  // Re-fetch outputDigest from the tampered proof
  const verification = verifyExecutionProof(
    tampered,
    task, undefined, result.stdout, result.stderr
  );
  // outputDigest won't match because the computed one differs from tampered.
  // But it's also possible the chain breaks.  Either way, valid=false.
  assert.equal(verification.valid, false);
});

test("verifyExecutionProof succeeds with expanded task", () => {
  const task = BASE_TASK;
  const expanded: RunnerTask = { ...task, commands: ["echo expanded"] };
  const result = { ...BASE_RESULT, stdout: "expanded\n", stderr: "" };
  const proof = buildExecutionProof({ task, result, expanded, runToken: "verify-5" });

  const verification = verifyExecutionProof(proof, task, expanded, result.stdout, result.stderr);
  assert.ok(verification.valid);
});
