import assert from "node:assert/strict";
import test from "node:test";
import {
  isGithubProposePatchTask,
  isEnvTruthy,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
} from "./integration.js";
import type { HandlerTask, HandlerEnv, RawRunnerOutput } from "./integration.js";

// ── isGithubProposePatchTask ───────────────────────────────────────────────

test("isGithubProposePatchTask: detects payload.mode === github-propose-patch", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch" } };
  assert.equal(isGithubProposePatchTask(task), true);
});

test("isGithubProposePatchTask: detects taskOrigin === github", () => {
  const task: HandlerTask = { taskOrigin: "github" };
  assert.equal(isGithubProposePatchTask(task), true);
});

test("isGithubProposePatchTask: false for normal propose_patch", () => {
  const task: HandlerTask = { payload: { mode: "propose_patch" } };
  assert.equal(isGithubProposePatchTask(task), false);
});

test("isGithubProposePatchTask: false for undefined mode", () => {
  const task: HandlerTask = { intent: "chat" };
  assert.equal(isGithubProposePatchTask(task), false);
});

test("isGithubProposePatchTask: false for null payload", () => {
  const task: HandlerTask = { id: "t1" };
  assert.equal(isGithubProposePatchTask(task), false);
});

// ── isEnvTruthy ────────────────────────────────────────────────────────────

test("isEnvTruthy: true for 1/true/yes/on", () => {
  assert.equal(isEnvTruthy("1"), true);
  assert.equal(isEnvTruthy("true"), true);
  assert.equal(isEnvTruthy("yes"), true);
  assert.equal(isEnvTruthy("on"), true);
  assert.equal(isEnvTruthy("ON"), true);
});

test("isEnvTruthy: false for 0/false/no/off/empty/undefined", () => {
  assert.equal(isEnvTruthy("0"), false);
  assert.equal(isEnvTruthy("false"), false);
  assert.equal(isEnvTruthy("no"), false);
  assert.equal(isEnvTruthy(""), false);
  assert.equal(isEnvTruthy(undefined), false);
});

// ── shouldUseDockerRunnerForGithub ─────────────────────────────────────────

const baseEnv: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1" };

test("shouldUseDockerRunnerForGithub: false when disabled", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, {}), false);
});

test("shouldUseDockerRunnerForGithub: false when not a github-propose-patch task", () => {
  const task: HandlerTask = { payload: { mode: "propose_patch" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), false);
});

test("shouldUseDockerRunnerForGithub: true when all-github mode", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "any/repo" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, { ...baseEnv, A2A_DOCKER_RUNNER_ALL_GITHUB: "1" }), true);
});

test("shouldUseDockerRunnerForGithub: true for openclaw-plugin-a2a preset", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", runnerPreset: "openclaw-plugin-a2a-dev" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), true);
});

test("shouldUseDockerRunnerForGithub: true for openclaw-plugin-a2a repo", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinon86/openclaw-plugin-a2a" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), true);
});

test("shouldUseDockerRunnerForGithub: false for unrelated repo without all-github", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinon86/a2a-docker-runner" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), false);
});

// ── buildRunnerTaskFromHandlerPayload ── openclaw-plugin-a2a-dev preset ────

test("buildRunnerTaskFromHandlerPayload: openclaw-plugin-a2a-dev preset", () => {
  const task: HandlerTask = {
    id: "task-abc",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", runnerPreset: "openclaw-plugin-a2a-dev", baseBranch: "develop" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.id, "task-abc");
  assert.equal(result.intent, "propose_patch");
  assert.equal(result.mode, "github-propose-patch");
  assert.equal(result.preset, "openclaw-plugin-a2a-dev");
  assert.equal(result.baseBranch, "develop");
  assert.equal(result.timeoutMs, 45 * 60 * 1000);
});

test("buildRunnerTaskFromHandlerPayload: explicit repo path", () => {
  const task: HandlerTask = {
    id: "task-def",
    payload: { mode: "github-propose-patch", repo: "jinon86/seoyoon-family-wiki", baseBranch: "master", issue: "42", issueUrl: "https://github.com/jinon86/seoyoon-family-wiki/issues/42" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.id, "task-def");
  assert.equal(result.repo, "jinon86/seoyoon-family-wiki");
  assert.equal(result.baseBranch, "master");
  assert.equal(result.issueUrl, "https://github.com/jinon86/seoyoon-family-wiki/issues/42");
});

test("buildRunnerTaskFromHandlerPayload: constructs issueUrl from repo + issue", () => {
  const task: HandlerTask = {
    id: "task-ghi",
    payload: { mode: "github-propose-patch", repo: "jinon86/test-repo", issue: "#5" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, "https://github.com/jinon86/test-repo/issues/5");
});

test("buildRunnerTaskFromHandlerPayload: constructs issueUrl from issueNumber", () => {
  const task: HandlerTask = {
    id: "task-jkl",
    payload: { mode: "github-propose-patch", repo: "jinon86/test-repo", issueNumber: "7" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, "https://github.com/jinon86/test-repo/issues/7");
});

test("buildRunnerTaskFromHandlerPayload: generates fallback id when missing", () => {
  const task: HandlerTask = {
    payload: { mode: "github-propose-patch", repo: "jinon86/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.ok(typeof result.id === "string" && result.id.length > 0);
  assert.ok(result.id.startsWith("task-"));
});

// ── parseRunnerOutput ──────────────────────────────────────────────────────

test("parseRunnerOutput: parses valid runner JSON", () => {
  const raw = JSON.stringify({
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/t1",
    exitCode: 0,
    signal: null,
    stdout: "PR created: https://github.com/jinon86/repo/pull/1",
    stderr: "",
    artifacts: ["/tmp/a2a/t1/artifacts/summary.txt"],
    prUrl: "https://github.com/jinon86/repo/pull/1",
  });
  const result = parseRunnerOutput(raw);
  assert.equal(result.ok, true);
  assert.equal(result.prUrl, "https://github.com/jinon86/repo/pull/1");
});

test("parseRunnerOutput: throws on empty string", () => {
  assert.throws(() => parseRunnerOutput(""), { message: /no output/ });
});

test("parseRunnerOutput: throws on invalid JSON", () => {
  assert.throws(() => parseRunnerOutput("not json"));
});

test("parseRunnerOutput: throws when missing required fields", () => {
  assert.throws(() => parseRunnerOutput('{"other": true}'), { message: /missing required fields/ });
});

// ── extractGitHubEvidence ──────────────────────────────────────────────────

test("extractGitHubEvidence: extracts prUrl from github evidence block", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
    github: { prUrl: "https://github.com/jinon86/repo/pull/42" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinon86/repo/pull/42");
});

test("extractGitHubEvidence: extracts blockCommentUrl", () => {
  const result: RawRunnerOutput = {
    ok: false,
    taskId: "t1",
    status: "failed",
    workDir: "/tmp",
    stdout: "",
    stderr: "error",
    artifacts: [],
    github: { blockCommentUrl: "https://github.com/jinon86/repo/issues/5#issuecomment-123" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinon86/repo/issues/5#issuecomment-123");
});

test("extractGitHubEvidence: extracts doneCommentUrl", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
    github: { doneCommentUrl: "https://github.com/jinon86/repo/issues/5#issuecomment-456" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.doneCommentUrl, "https://github.com/jinon86/repo/issues/5#issuecomment-456");
});

test("extractGitHubEvidence: falls back to legacy prUrl", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinon86/repo/pull/99",
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinon86/repo/pull/99");
});

test("extractGitHubEvidence: returns null when no evidence", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
  };
  const evidence = extractGitHubEvidence(result);
  assert.equal(evidence, null);
});

// ── buildHandlerResult ─────────────────────────────────────────────────────

test("buildHandlerResult: pr_opened when prUrl present", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
    github: { prUrl: "https://github.com/jinon86/repo/pull/99" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.prUrl, "https://github.com/jinon86/repo/pull/99");
});

test("buildHandlerResult: blocked when blockCommentUrl present and no prUrl", () => {
  const result: RawRunnerOutput = {
    ok: false,
    taskId: "t1",
    status: "failed",
    workDir: "/tmp",
    stdout: "",
    stderr: "error",
    artifacts: [],
    github: { blockCommentUrl: "https://github.com/jinon86/repo/issues/5#issuecomment-123" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.blockCommentUrl, "https://github.com/jinon86/repo/issues/5#issuecomment-123");
});

test("buildHandlerResult: done when doneCommentUrl present and no prUrl/block", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
    github: { doneCommentUrl: "https://github.com/jinon86/repo/issues/5#issuecomment-456" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "done");
  assert.equal(handlerResult.doneCommentUrl, "https://github.com/jinon86/repo/issues/5#issuecomment-456");
});

test("buildHandlerResult: blocked when no evidence at all", () => {
  const result: RawRunnerOutput = {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp",
    stdout: "",
    stderr: "",
    artifacts: [],
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "blocked");
});

// ── Edge cases: full openclaw-plugin-a2a-dev integration flow ──────────────

test("integration flow: openclaw-plugin-a2a-dev preset → runner task → parse → evidence", () => {
  // 1. Handler task
  const task: HandlerTask = {
    id: "a2a-integ-1",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", runnerPreset: "openclaw-plugin-a2a-dev" },
  };

  // 2. Should use Docker runner
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), true);

  // 3. Build runner task
  const runnerTask = buildRunnerTaskFromHandlerPayload(task, baseEnv);
  assert.equal(runnerTask.preset, "openclaw-plugin-a2a-dev");

  // 4. Simulated runner output
  const raw = JSON.stringify({
    ok: true,
    taskId: "a2a-integ-1",
    status: "completed",
    workDir: "/var/lib/openclaw-a2a/tasks/a2a-integ-1",
    exitCode: 0,
    stdout: "PR created: https://github.com/jinon86/openclaw-plugin-a2a/pull/42",
    stderr: "",
    artifacts: ["/var/lib/openclaw-a2a/tasks/a2a-integ-1/artifacts/summary.txt"],
    github: { prUrl: "https://github.com/jinon86/openclaw-plugin-a2a/pull/42" },
  });

  // 5. Parse → evidence → handler result
  const parsed = parseRunnerOutput(raw);
  const evidence = extractGitHubEvidence(parsed);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinon86/openclaw-plugin-a2a/pull/42");

  const handlerResult = buildHandlerResult(parsed, task, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
});
