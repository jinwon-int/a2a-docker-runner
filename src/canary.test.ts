/**
 * CI-safe handler-to-runner end-to-end canary fixture.
 *
 * Exercises the full integration contract without Docker, live broker,
 * or GitHub mutation:
 *
 *   HandlerTask → buildRunnerTaskFromHandlerPayload → task.json →
 *   spawn fake-runner.sh → parseRunnerOutput → extractGitHubEvidence →
 *   buildHandlerResult
 *
 * Paths covered: PR, Done, Block, malformed, failure/timeout, crash
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  isGithubProposePatchTask,
  isEnvTruthy,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
} from "./integration.js";
import type { HandlerTask, HandlerEnv } from "./integration.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_RUNNER = resolve(__dirname, "..", "scripts", "fake-runner.sh");

const baseEnv: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1" };

let canaryTmpDir: string;

/**
 * Spawn the fake runner with a given mode and task JSON file.
 * Returns { stdout, stderr, code }.
 */
function spawnFakeRunner(
  mode: string,
  taskFile: string,
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [FAKE_RUNNER, "run", taskFile], {
      env: { ...process.env, FAKE_RUNNER_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ stdout, stderr, code, signal });
    });
  });
}

/** Write a task JSON file to a temp directory and return the path. */
async function writeTaskJson(task: object): Promise<string> {
  if (!canaryTmpDir) {
    canaryTmpDir = join(tmpdir(), `a2a-canary-${randomUUID()}`);
    await mkdir(canaryTmpDir, { recursive: true, mode: 0o700 });
  }
  const file = join(canaryTmpDir, `task-${randomUUID().slice(0, 8)}.json`);
  await writeFile(file, JSON.stringify(task, null, 2));
  return file;
}

/** Build a full handler task for canary testing. */
function makeCanaryHandlerTask(overrides?: Partial<HandlerTask>): HandlerTask {
  return {
    id: `canary-${randomUUID().slice(0, 8)}`,
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
      issue: "#11",
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/11",
      baseBranch: "main",
      ...overrides?.payload,
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — Contract: handler builds runner task correctly
// ═══════════════════════════════════════════════════════════════════════════

test("canary phase1: handler builds valid runner task from payload", () => {
  const task = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(runnerTask.mode, "github-propose-patch");
  assert.equal(runnerTask.repo, "jinwon-int/a2a-docker-runner");
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/11");
  assert.ok(typeof runnerTask.id === "string" && runnerTask.id.length > 0);
  assert.equal(runnerTask.reportLanguage, "ko");
});

test("canary phase1: shouldUseDockerRunnerForGithub with ALL_GITHUB=1 routes any repo", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_ALL_GITHUB: "1" };
  const task = makeCanaryHandlerTask();
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — E2E: spawn fake runner → parse → evidence → handler result
// ═══════════════════════════════════════════════════════════════════════════

test("canary e2e: PR path — fake runner emits success JSON with prUrl", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  const { stdout, stderr, code } = await spawnFakeRunner("pr", taskFile);

  // Fake runner must exit 0 and produce valid JSON
  assert.equal(code, 0, `fake runner exit code: ${code}, stderr: ${stderr}`);
  assert.ok(stdout.trim().length > 0, "fake runner produced no stdout");

  // Parse → evidence → handler result
  const parsed = parseRunnerOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "completed");

  const evidence = extractGitHubEvidence(parsed);
  assert.ok(evidence, "expected GitHub evidence");
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/99");

  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.prUrl, evidence?.prUrl);
  assert.equal(handlerResult.risks.length, 0);
  assert.ok(handlerResult.summary.length > 0);
});

test("canary e2e: Done path — fake runner emits success JSON with doneCommentUrl", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  const { stdout, code } = await spawnFakeRunner("done", taskFile);

  assert.equal(code, 0);
  const parsed = parseRunnerOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "completed");

  const evidence = extractGitHubEvidence(parsed);
  assert.ok(evidence);
  assert.equal(evidence?.doneCommentUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/11#issuecomment-canary-done");
  assert.equal(evidence?.prUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);

  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");
  assert.equal(handlerResult.status, "done");
  assert.equal(handlerResult.doneCommentUrl, evidence?.doneCommentUrl);
});

test("canary e2e: Block path — fake runner emits failure JSON with blockCommentUrl", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  const { stdout, code } = await spawnFakeRunner("block", taskFile);

  // Block mode exits 1 (non-zero)
  assert.equal(code, 1);
  const parsed = parseRunnerOutput(stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "failed");
  assert.ok(parsed.error?.includes("build failed"));

  const evidence = extractGitHubEvidence(parsed);
  assert.ok(evidence);
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/11#issuecomment-canary-block");

  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.blockCommentUrl, evidence?.blockCommentUrl);
});

test("canary e2e: Failure/timeout path — fake runner emits timeout JSON with no evidence", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  const { stdout, code } = await spawnFakeRunner("failure", taskFile);

  // Failure mode exits 1
  assert.equal(code, 1);
  const parsed = parseRunnerOutput(stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "timeout");
  assert.equal(parsed.signal, "SIGTERM");

  // No structured evidence in failure mode
  const evidence = extractGitHubEvidence(parsed);
  assert.equal(evidence, null);

  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.ok(handlerResult.summary.includes("without PR/Done/Block evidence"));
  assert.ok(handlerResult.risks.length > 0);
});

test("canary e2e: Malformed path — fake runner emits invalid JSON", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  const { stdout, code } = await spawnFakeRunner("malformed", taskFile);

  // Malformed mode exits 0 but produces garbage
  assert.equal(code, 0);
  assert.throws(
    () => parseRunnerOutput(stdout),
    (err: unknown) => err instanceof Error && err.message.length > 0,
    "malformed output should throw on parse",
  );
});

test("canary e2e: Crash path — fake runner exits non-zero with truncated output", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  const { stdout, code } = await spawnFakeRunner("crash", taskFile);

  // Crash mode exits 137 with truncated JSON
  assert.notEqual(code, 0);
  assert.throws(
    () => parseRunnerOutput(stdout),
    "truncated JSON from crash should throw on parse",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — Canary deployment simulation (ALL_GITHUB + timeout env)
// ═══════════════════════════════════════════════════════════════════════════

test("canary e2e: full deployment canary — ALL_GITHUB=1 + timeout env passthrough", async () => {
  const canaryEnv: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
    A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: "120000",
  };

  const handlerTask = makeCanaryHandlerTask();
  assert.equal(shouldUseDockerRunnerForGithub(handlerTask, canaryEnv), true);

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, canaryEnv);
  assert.equal(runnerTask.timeoutMs, 120000);

  const taskFile = await writeTaskJson(runnerTask);
  const { stdout, code } = await spawnFakeRunner("pr", taskFile);

  assert.equal(code, 0);
  const parsed = parseRunnerOutput(stdout);
  assert.equal(parsed.ok, true);

  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
  assert.ok(handlerResult.prUrl?.includes("/pull/99"));
});

test("canary e2e: rollback simulation — ENABLED=0 bypasses runner entirely", async () => {
  const rollbackEnv: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "0" };
  const handlerTask = makeCanaryHandlerTask();

  // Should NOT route through runner
  assert.equal(shouldUseDockerRunnerForGithub(handlerTask, rollbackEnv), false);

  // Should still build a valid runner task (handler may still call this)
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, rollbackEnv);
  assert.equal(runnerTask.repo, "jinwon-int/a2a-docker-runner");
});

test("canary e2e: partial rollback — ALL_GITHUB unset, preset routing only", async () => {
  const partialEnv: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    // ALL_GITHUB intentionally absent
  };

  // a2a-docker-runner repo should NOT route (no matching preset)
  const handlerTask = makeCanaryHandlerTask();
  assert.equal(shouldUseDockerRunnerForGithub(handlerTask, partialEnv), false);

  // openclaw-plugin-a2a should still route
  const a2aTask: HandlerTask = {
    id: "canary-preset",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" },
  };
  assert.equal(shouldUseDockerRunnerForGithub(a2aTask, partialEnv), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — Evidence precedence and edge cases (full pipeline)
// ═══════════════════════════════════════════════════════════════════════════

test("canary e2e: handler summary includes task ID and Korean context", async () => {
  const handlerTask: HandlerTask = {
    id: "한글-카나리-태스크",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/a2a-docker-runner", issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/11" },
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);
  const { stdout } = await spawnFakeRunner("pr", taskFile);

  const parsed = parseRunnerOutput(stdout);
  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");

  assert.equal(handlerResult.status, "pr_opened");
  assert.ok(handlerResult.summary.includes("한글-카나리-태스크"));
});

test("canary e2e: artifacts from fake runner propagated to handler result", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);
  const { stdout } = await spawnFakeRunner("pr", taskFile);

  const parsed = parseRunnerOutput(stdout);
  assert.ok(parsed.artifacts.length >= 2, `expected >= 2 artifacts, got ${parsed.artifacts.length}`);

  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");
  assert.ok(handlerResult.filesChanged.length >= 2);
  assert.ok(handlerResult.filesChanged.some((f) => f.includes("summary.txt")));
  assert.ok(handlerResult.filesChanged.some((f) => f.includes("canary-result.txt")));
});

test("canary e2e: runnerRaw included in handler result for debugging", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);
  const { stdout } = await spawnFakeRunner("pr", taskFile);

  const parsed = parseRunnerOutput(stdout);
  const handlerResult = buildHandlerResult(parsed, handlerTask, "sogyo");

  assert.ok(handlerResult.runnerRaw);
  assert.equal((handlerResult.runnerRaw as Record<string, unknown>).ok, true);
});

test("canary e2e: tests array is always present and non-empty on success", async () => {
  const handlerTask = makeCanaryHandlerTask();
  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  const taskFile = await writeTaskJson(runnerTask);

  for (const mode of ["pr", "done"]) {
    const { stdout } = await spawnFakeRunner(mode, taskFile);
    const parsed = parseRunnerOutput(stdout);
    const hr = buildHandlerResult(parsed, handlerTask, "sogyo");
    assert.ok(Array.isArray(hr.tests), `tests should be array for mode ${mode}`);
    assert.ok(hr.tests.length > 0, `tests should be non-empty for mode ${mode}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — Real canary smoke: verify fake-runner.sh is executable
// ═══════════════════════════════════════════════════════════════════════════

test("canary smoke: fake-runner.sh is present and executable", async () => {
  const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>((resolvePromise) => {
    const child = spawn("bash", [FAKE_RUNNER, "pr"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (c) => resolvePromise({ stdout: out, code: c }));
  });

  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "completed");
});
