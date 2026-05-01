/**
 * Integration seam contract tests for openclaw-a2a-worker handler.
 *
 * Covers:
 * - Feature-flag bypass (host-workspace direct execution bypass)
 * - PR/Block/Done/malformed/timeout evidence mapping
 * - Env passthrough and preset resolution
 * - Full canary-task round-trip simulation
 */

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

// ═══════════════════════════════════════════════════════════════════════════
// isGithubProposePatchTask
// ═══════════════════════════════════════════════════════════════════════════

test("isGithubProposePatchTask: detects payload.mode === github-propose-patch", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch" } };
  assert.equal(isGithubProposePatchTask(task), true);
});

test("isGithubProposePatchTask: detects taskOrigin === github (legacy)", () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// isEnvTruthy
// ═══════════════════════════════════════════════════════════════════════════

test("isEnvTruthy: true for 1/true/yes/on (case-insensitive)", () => {
  assert.equal(isEnvTruthy("1"), true);
  assert.equal(isEnvTruthy("true"), true);
  assert.equal(isEnvTruthy("yes"), true);
  assert.equal(isEnvTruthy("on"), true);
  assert.equal(isEnvTruthy("ON"), true);
  assert.equal(isEnvTruthy("Yes"), true);
});

test("isEnvTruthy: false for 0/false/no/off/empty/undefined/whitespace", () => {
  assert.equal(isEnvTruthy("0"), false);
  assert.equal(isEnvTruthy("false"), false);
  assert.equal(isEnvTruthy("no"), false);
  assert.equal(isEnvTruthy("off"), false);
  assert.equal(isEnvTruthy(""), false);
  assert.equal(isEnvTruthy(undefined), false);
  assert.equal(isEnvTruthy("   "), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// shouldUseDockerRunnerForGithub — Feature-flag routing tests
// ═══════════════════════════════════════════════════════════════════════════

const baseEnv: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1" };

test("shouldUseDockerRunnerForGithub: false when A2A_DOCKER_RUNNER_ENABLED is 0 (host-workspace bypass)", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, { A2A_DOCKER_RUNNER_ENABLED: "0" }), false);
});

test("shouldUseDockerRunnerForGithub: false when A2A_DOCKER_RUNNER_ENABLED is not set (host-workspace bypass)", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, {}), false);
});

test("shouldUseDockerRunnerForGithub: false when A2A_DOCKER_RUNNER_ENABLED is explicitly false", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, { A2A_DOCKER_RUNNER_ENABLED: "false" }), false);
});

test("shouldUseDockerRunnerForGithub: false when A2A_DOCKER_RUNNER_ENABLED=off (host-workspace bypass)", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, { A2A_DOCKER_RUNNER_ENABLED: "off" }), false);
});

test("shouldUseDockerRunnerForGithub: false when not a github-propose-patch task", () => {
  const task: HandlerTask = { payload: { mode: "propose_patch" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), false);
});

test("shouldUseDockerRunnerForGithub: false when task is chat", () => {
  const task: HandlerTask = { intent: "chat" };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), false);
});

test("shouldUseDockerRunnerForGithub: true when A2A_DOCKER_RUNNER_ALL_GITHUB=1 routes ANY repo", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_ALL_GITHUB: "1" };
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/random-repo" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

test("shouldUseDockerRunnerForGithub: A2A_DOCKER_RUNNER_ALL_GITHUB=1 overrides preset-only restriction", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_ALL_GITHUB: "1" };
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/a2a-docker-runner" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

test("shouldUseDockerRunnerForGithub: true for openclaw-plugin-a2a preset from payload", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", runnerPreset: "openclaw-plugin-a2a-dev" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), true);
});

test("shouldUseDockerRunnerForGithub: true for openclaw-plugin-a2a preset from env", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_PRESET: "openclaw-plugin-a2a-dev" };
  const task: HandlerTask = { payload: { mode: "github-propose-patch" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

test("shouldUseDockerRunnerForGithub: true for openclaw-plugin-a2a repo pattern", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), true);
});

test("shouldUseDockerRunnerForGithub: false for unrelated repo without all-github flag", () => {
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "jinwon-int/a2a-docker-runner" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), false);
});

test("shouldUseDockerRunnerForGithub: A2A_DOCKER_RUNNER_ALL_GITHUB=yes works", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_ALL_GITHUB: "yes" };
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "any/repo" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

test("shouldUseDockerRunnerForGithub: A2A_DOCKER_RUNNER_ALL_GITHUB=on works", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_ALL_GITHUB: "on" };
  const task: HandlerTask = { payload: { mode: "github-propose-patch", repo: "any/repo" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

test("shouldUseDockerRunnerForGithub: prefers payload preset over env preset", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_PRESET: "other-preset" };
  const task: HandlerTask = { payload: { mode: "github-propose-patch", runnerPreset: "openclaw-plugin-a2a-dev" } };
  assert.equal(shouldUseDockerRunnerForGithub(task, env), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildRunnerTaskFromHandlerPayload — Env passthrough tests
// ═══════════════════════════════════════════════════════════════════════════

test("buildRunnerTaskFromHandlerPayload: openclaw-plugin-a2a-dev preset via payload.runnerPreset", () => {
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

test("buildRunnerTaskFromHandlerPayload: env A2A_DOCKER_RUNNER_PRESET passthrough", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_PRESET: "openclaw-plugin-a2a-dev" };
  const task: HandlerTask = {
    id: "task-env-preset",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", baseBranch: "develop" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, env);

  assert.equal(result.preset, "openclaw-plugin-a2a-dev");
  assert.equal(result.baseBranch, "develop");
});

test("buildRunnerTaskFromHandlerPayload: env A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS passthrough", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: "600000" };
  const task: HandlerTask = {
    id: "task-timeout",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, env);

  assert.equal(result.timeoutMs, 600000);
});

test("buildRunnerTaskFromHandlerPayload: env timeout override takes precedence over payload timeout", () => {
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1", A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: "300000" };
  const task: HandlerTask = {
    id: "task-override",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo", timeoutMs: 900000 },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, env);

  assert.equal(result.timeoutMs, 300000);
});

test("buildRunnerTaskFromHandlerPayload: closeout/comment-only flags and existing PR passthrough", () => {
  const task: HandlerTask = {
    id: "task-closeout",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/test-repo",
      issueNumber: "73",
      prNumber: "#12",
      noNewPr: true,
      evidenceOnly: true,
    },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, "https://github.com/jinwon-int/test-repo/issues/73");
  assert.equal(result.existingPrUrl, "https://github.com/jinwon-int/test-repo/pull/12");
  assert.equal(result.existingPrNumber, "#12");
  assert.equal(result.forbidNewPr, true);
  assert.equal(result.commentOnly, true);
});

test("buildRunnerTaskFromHandlerPayload: payload timeout used when env timeout is unset", () => {
  const task: HandlerTask = {
    id: "task-payload-timeout",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo", timeoutMs: 900000 },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.timeoutMs, 900000);
});

test("buildRunnerTaskFromHandlerPayload: env extra args JSON passthrough (A2A_DOCKER_RUNNER_ARGS_JSON)", () => {
  const env: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_ARGS_JSON: '["--debug","--engine","podman"]',
  };
  const task: HandlerTask = {
    id: "task-args",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, env);

  // A2A_DOCKER_RUNNER_ARGS_JSON is stored for handler-side CLI construction,
  // not injected into RunnerTask directly. The handler reads this from env.
  assert.equal(result.repo, "jinwon-int/test-repo");
  assert.equal(result.mode, "github-propose-patch");
});

test("buildRunnerTaskFromHandlerPayload: explicit repo path with all fields", () => {
  const task: HandlerTask = {
    id: "task-def",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/seoyoon-family-wiki", baseBranch: "master", issue: "42", issueUrl: "https://github.com/jinwon-int/seoyoon-family-wiki/issues/42" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.id, "task-def");
  assert.equal(result.repo, "jinwon-int/seoyoon-family-wiki");
  assert.equal(result.baseBranch, "master");
  assert.equal(result.issueUrl, "https://github.com/jinwon-int/seoyoon-family-wiki/issues/42");
});

test("buildRunnerTaskFromHandlerPayload: constructs issueUrl from repo + issue number", () => {
  const task: HandlerTask = {
    id: "task-ghi",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo", issue: "#5" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, "https://github.com/jinwon-int/test-repo/issues/5");
});

test("buildRunnerTaskFromHandlerPayload: constructs issueUrl from issueNumber field", () => {
  const task: HandlerTask = {
    id: "task-jkl",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo", issueNumber: "7" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, "https://github.com/jinwon-int/test-repo/issues/7");
});

test("buildRunnerTaskFromHandlerPayload: issueUrl from issueNumber without # prefix", () => {
  const task: HandlerTask = {
    id: "task-mno",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo", issueNumber: "11" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, "https://github.com/jinwon-int/test-repo/issues/11");
});

test("buildRunnerTaskFromHandlerPayload: no issueUrl when repo absent", () => {
  const task: HandlerTask = {
    id: "task-no-repo",
    payload: { mode: "github-propose-patch", issue: "5" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, undefined);
});

test("buildRunnerTaskFromHandlerPayload: no issueUrl when issue/issueNumber absent", () => {
  const task: HandlerTask = {
    id: "task-no-issue",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.issueUrl, undefined);
});

test("buildRunnerTaskFromHandlerPayload: generates fallback id when task.id is missing", () => {
  const task: HandlerTask = {
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.ok(typeof result.id === "string" && result.id.length > 0);
  assert.ok(result.id.startsWith("task-"));
});

test("buildRunnerTaskFromHandlerPayload: message from task.message when payload.prompt absent", () => {
  const task: HandlerTask = {
    id: "task-msg",
    message: "Fix the bug in authentication",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.prompt, "Fix the bug in authentication");
});

test("buildRunnerTaskFromHandlerPayload: task.message takes precedence over payload.prompt (?? operator)", () => {
  const task: HandlerTask = {
    id: "task-prompt-prio",
    message: "Generic message",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo", prompt: "Specific prompt" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  // task.message takes precedence due to ?? operator ordering
  assert.equal(result.prompt, "Generic message");
});

test("buildRunnerTaskFromHandlerPayload: empty prompt when both message and payload.prompt absent", () => {
  const task: HandlerTask = {
    id: "task-no-msg",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.prompt, "");
});

test("buildRunnerTaskFromHandlerPayload: reportLanguage defaults to ko", () => {
  const task: HandlerTask = {
    id: "task-lang",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.reportLanguage, "ko");
});

test("buildRunnerTaskFromHandlerPayload: default timeout is 45 minutes", () => {
  const task: HandlerTask = {
    id: "task-default-timeout",
    payload: { mode: "github-propose-patch", repo: "jinwon-int/test-repo" },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.timeoutMs, 45 * 60 * 1000);
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRunnerOutput — Success / Malformed / Timeout tests
// ═══════════════════════════════════════════════════════════════════════════

test("parseRunnerOutput: parses valid completed runner JSON", () => {
  const raw = JSON.stringify({
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/t1",
    exitCode: 0,
    signal: null,
    stdout: "PR created: https://github.com/jinwon-int/repo/pull/1",
    stderr: "",
    artifacts: ["/tmp/a2a/t1/artifacts/summary.txt"],
    prUrl: "https://github.com/jinwon-int/repo/pull/1",
  });
  const result = parseRunnerOutput(raw);
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.prUrl, "https://github.com/jinwon-int/repo/pull/1");
  assert.equal(result.exitCode, 0);
});

test("parseRunnerOutput: parses valid failed runner JSON", () => {
  const raw = JSON.stringify({
    ok: false,
    taskId: "t2",
    status: "failed",
    workDir: "/tmp/a2a/t2",
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "build error",
    artifacts: [],
    error: "build error",
  });
  const result = parseRunnerOutput(raw);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "build error");
});

test("parseRunnerOutput: parses timeout runner JSON", () => {
  const raw = JSON.stringify({
    ok: false,
    taskId: "t3",
    status: "timeout",
    workDir: "/tmp/a2a/t3",
    exitCode: null,
    signal: "SIGTERM",
    stdout: "partial output",
    stderr: "container timed out after 2700000ms",
    artifacts: [],
    error: "timeout exceeded",
  });
  const result = parseRunnerOutput(raw);
  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.equal(result.signal, "SIGTERM");
});

test("parseRunnerOutput: handles whitespace around JSON", () => {
  const raw = `
  {
    "ok": true,
    "taskId": "t4",
    "status": "completed",
    "workDir": "/tmp",
    "exitCode": 0,
    "stdout": "ok",
    "stderr": "",
    "artifacts": []
  }
  `;
  const result = parseRunnerOutput(raw);
  assert.equal(result.ok, true);
});

test("parseRunnerOutput: throws on empty string", () => {
  assert.throws(() => parseRunnerOutput(""), { message: /no output/ });
});

test("parseRunnerOutput: throws on whitespace-only string", () => {
  assert.throws(() => parseRunnerOutput("   \n\t  "), { message: /no output/ });
});

test("parseRunnerOutput: throws on invalid JSON", () => {
  assert.throws(() => parseRunnerOutput("not json"));
});

test("parseRunnerOutput: throws on null JSON value", () => {
  assert.throws(() => parseRunnerOutput("null"));
});

test("parseRunnerOutput: throws on array JSON value", () => {
  assert.throws(() => parseRunnerOutput("[]"));
});

test("parseRunnerOutput: throws when missing required fields (ok=false but ok is not present)", () => {
  assert.throws(() => parseRunnerOutput('{"taskId": "t", "status": "completed"}'), { message: /missing required fields/ });
});

test("parseRunnerOutput: throws when ok is not boolean", () => {
  assert.throws(() => parseRunnerOutput('{"ok": "yes", "taskId": "t", "status": "completed"}'), { message: /missing required fields/ });
});

test("parseRunnerOutput: throws on truncated JSON", () => {
  assert.throws(() => parseRunnerOutput('{"ok": true, "taskId": "t", "sta'));
});

test("parseRunnerOutput: throws on non-JSON runner crash output", () => {
  assert.throws(() => parseRunnerOutput("Error: container crashed\n    at spawn () {}"));
});

// ═══════════════════════════════════════════════════════════════════════════
// extractGitHubEvidence — Structured evidence extraction
// ═══════════════════════════════════════════════════════════════════════════

test("extractGitHubEvidence: extracts prUrl from github evidence block", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/42" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/repo/pull/42");
});

test("extractGitHubEvidence: extracts blockCommentUrl from github evidence block", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t1", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "error", artifacts: [],
    github: { blockCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-123");
});

test("extractGitHubEvidence: extracts doneCommentUrl from github evidence block", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.doneCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-456");
});

test("extractGitHubEvidence: PR evidence takes precedence over block+done (multiple URLs in github block)", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: {
      prUrl: "https://github.com/jinwon-int/repo/pull/42",
      blockCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123",
      doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456",
    },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/repo/pull/42");
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("extractGitHubEvidence: block takes precedence over done (no PR url)", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t2", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: {
      blockCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123",
      doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456",
    },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-123");
});

test("extractGitHubEvidence: falls back to legacy prUrl when github block absent", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    prUrl: "https://github.com/jinwon-int/repo/pull/99",
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/repo/pull/99");
});

test("extractGitHubEvidence: returns null when no evidence at all", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
  };
  const evidence = extractGitHubEvidence(result);
  assert.equal(evidence, null);
});

test("extractGitHubEvidence: returns null for empty github evidence object", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: {},
  };
  const evidence = extractGitHubEvidence(result);
  assert.equal(evidence, null);
});

test("extractGitHubEvidence: legacy prUrl ignored when github evidence has content", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    prUrl: "https://github.com/jinwon-int/repo/pull/old",
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/new" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/repo/pull/new");
});

// ═══════════════════════════════════════════════════════════════════════════
// buildHandlerResult — PR/Block/Done + timeout + malformed mapping
// ═══════════════════════════════════════════════════════════════════════════

test("buildHandlerResult: status pr_opened when prUrl present", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/99" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.prUrl, "https://github.com/jinwon-int/repo/pull/99");
  assert.equal(handlerResult.risks.length, 0);
});

test("buildHandlerResult: status blocked when blockCommentUrl present and no prUrl", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t1", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "error", artifacts: [],
    github: { blockCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.blockCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-123");
  assert.equal(handlerResult.prUrl, undefined);
});

test("buildHandlerResult: status done when doneCommentUrl present and no prUrl/block", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "done");
  assert.equal(handlerResult.doneCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-456");
});

test("buildHandlerResult: blocked when no evidence at all (completed but no PR)", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.ok(handlerResult.summary.includes("without PR/Done/Block evidence"));
});

test("buildHandlerResult: blocked for timeout status with no evidence", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t-timeout", status: "timeout", workDir: "/tmp",
    stdout: "partial output", stderr: "container timed out", artifacts: [],
    error: "timeout exceeded",
  };
  const handlerResult = buildHandlerResult(result, { id: "t-timeout" }, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.risks[0], "runner completed without structured GitHub evidence");
});

test("buildHandlerResult: blocked for failed status with no evidence", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t-fail", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "build error", artifacts: [],
    error: "build failed",
  };
  const handlerResult = buildHandlerResult(result, { id: "t-fail" }, "sogyo");
  assert.equal(handlerResult.status, "blocked");
});

test("buildHandlerResult: pr_opened even when ok=false but prUrl exists (CR edge case)", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "cr-t1", status: "failed", workDir: "/tmp",
    stdout: "CR URL: https://github.com/jinwon-int/repo/pull/99", stderr: "minor lint warning", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/99" },
  };
  const handlerResult = buildHandlerResult(result, { id: "cr-t1" }, "sogyo");
  // PR evidence exists → status should still be pr_opened regardless of ok field
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.prUrl, "https://github.com/jinwon-int/repo/pull/99");
  assert.equal(handlerResult.risks.length, 0);
});

test("buildHandlerResult: includes runnerRaw for debugging", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "hello", stderr: "", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/1" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.ok(handlerResult.runnerRaw);
  assert.equal((handlerResult.runnerRaw as unknown as RawRunnerOutput).ok, true);
});

test("buildHandlerResult: includes tests array", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/1" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.equal(handlerResult.tests[0], "a2a-docker-runner run -> completed");
});

test("buildHandlerResult: includes filesChanged from artifacts", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: ["/tmp/a/task.json", "/tmp/a/summary.txt"],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/1" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  assert.deepEqual(handlerResult.filesChanged, ["/tmp/a/task.json", "/tmp/a/summary.txt"]);
});

test("buildHandlerResult: prefers artifactManifest paths for modern runner results", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t-modern", status: "completed", workDir: "/tmp/work",
    stdout: "", stderr: "", artifacts: ["/tmp/work/artifacts/summary.txt"],
    artifactManifest: {
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      artifacts: [{ path: "artifacts/summary.txt", name: "summary.txt", sizeBytes: 10 }],
    },
    resultSummary: {
      exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "",
      stdoutTruncated: false, stderrTruncated: false, artifactCount: 1, manifestPath: "artifacts/manifest.json",
    },
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/1" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t-modern" }, "sogyo");
  assert.deepEqual(handlerResult.filesChanged, ["artifacts/summary.txt"]);
  assert.deepEqual((handlerResult.runnerRaw as unknown as RawRunnerOutput).artifacts, ["artifacts/summary.txt"]);
});

test("buildHandlerResult: exposes bounded resultSummary stdout/stderr instead of raw large streams", () => {
  const rawStdout = "raw-stdout-".repeat(5000);
  const rawStderr = "raw-stderr-".repeat(5000);
  const result: RawRunnerOutput = {
    ok: true, taskId: "t-large", status: "completed", workDir: "/tmp",
    stdout: rawStdout, stderr: rawStderr, artifacts: [],
    resultSummary: {
      exitCode: 0, signal: null, timedOut: false,
      stdout: "bounded stdout\n<truncated 49900 chars>",
      stderr: "bounded stderr\n<truncated 49900 chars>",
      stdoutTruncated: true, stderrTruncated: true, artifactCount: 0, manifestPath: "artifacts/manifest.json",
    },
    github: { doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t-large" }, "sogyo");
  const runnerRaw = handlerResult.runnerRaw as unknown as RawRunnerOutput;
  assert.equal(runnerRaw.stdout, "bounded stdout\n<truncated 49900 chars>");
  assert.equal(runnerRaw.stderr, "bounded stderr\n<truncated 49900 chars>");
  assert.ok(!runnerRaw.stdout.includes("raw-stdout-raw-stdout-"));
  assert.ok(!runnerRaw.stderr.includes("raw-stderr-raw-stderr-"));
});

test("buildHandlerResult: PR takes precedence over block in evidence (deterministic ordering)", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "mixed", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "warning", artifacts: [],
    github: {
      prUrl: "https://github.com/jinwon-int/repo/pull/99",
      blockCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123",
    },
  };
  const handlerResult = buildHandlerResult(result, { id: "mixed" }, "sogyo");
  // PR > Block > Done
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.prUrl, "https://github.com/jinwon-int/repo/pull/99");
});

test("buildHandlerResult: nodeId does not affect status computation", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/1" },
  };
  // Different node IDs should produce identical status
  const sogyoResult = buildHandlerResult(result, { id: "t1" }, "sogyo");
  const bangtongResult = buildHandlerResult(result, { id: "t1" }, "bangtong");
  assert.equal(sogyoResult.status, bangtongResult.status);
  assert.equal(sogyoResult.prUrl, bangtongResult.prUrl);
});

// ═══════════════════════════════════════════════════════════════════════════
// Full integration flow simulation — canary task round-trip
// ═══════════════════════════════════════════════════════════════════════════

test("integration flow: openclaw-plugin-a2a-dev preset → runner task → parse → evidence → handler result", () => {
  // 1. Handler receives github-propose-patch task
  const task: HandlerTask = {
    id: "a2a-integ-1",
    intent: "propose_patch",
    payload: { mode: "github-propose-patch", runnerPreset: "openclaw-plugin-a2a-dev" },
  };

  // 2. Feature flag routing check
  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), true);

  // 3. Build runner task
  const runnerTask = buildRunnerTaskFromHandlerPayload(task, baseEnv);
  assert.equal(runnerTask.preset, "openclaw-plugin-a2a-dev");

  // 4. Simulated runner output (success with PR)
  const raw = JSON.stringify({
    ok: true,
    taskId: "a2a-integ-1",
    status: "completed",
    workDir: "/var/lib/openclaw-a2a/tasks/a2a-integ-1",
    exitCode: 0,
    stdout: "PR created: https://github.com/jinwon-int/openclaw-plugin-a2a/pull/42",
    stderr: "",
    artifacts: ["/var/lib/openclaw-a2a/tasks/a2a-integ-1/artifacts/summary.txt"],
    github: { prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/42" },
  });

  // 5. Parse → evidence → handler result
  const parsed = parseRunnerOutput(raw);
  const evidence = extractGitHubEvidence(parsed);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/42");

  const handlerResult = buildHandlerResult(parsed, task, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.summary.includes("a2a-integ-1"), true);
});

test("canary flow: shouldUseDockerRunnerForGithub with real-world env (ALL_GITHUB=1)", () => {
  // Simulate the recommended canary configuration
  const canaryEnv: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
    A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: "120000",
  };

  // Task targeting any repo — ALL_GITHUB=1 should route it
  const task: HandlerTask = {
    id: "canary-task-1",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
      issue: "11",
    },
  };

  // Verify: should route through Docker runner
  assert.equal(shouldUseDockerRunnerForGithub(task, canaryEnv), true);

  // Build runner task with 2-minute timeout
  const runnerTask = buildRunnerTaskFromHandlerPayload(task, canaryEnv);
  assert.equal(runnerTask.timeoutMs, 120000);
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/11");

  // Simulate runner output for a successful canary
  const raw = JSON.stringify({
    ok: true,
    taskId: "canary-task-1",
    status: "completed",
    workDir: "/var/lib/openclaw-a2a/tasks/canary-task-1",
    exitCode: 0,
    stdout: "canary smoke test passed",
    stderr: "",
    artifacts: ["/war/lib/openclaw-a2a/tasks/canary-task-1/artifacts/summary.txt"],
    github: { doneCommentUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/11#issuecomment-cana" },
  });

  const parsed = parseRunnerOutput(raw);
  const handlerResult = buildHandlerResult(parsed, task, "sogyo");
  assert.equal(handlerResult.status, "done");
});

test("canary flow: rollback — disable Docker runner, verify bypass", () => {
  // Rollback configuration
  const rollbackEnv: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "0",
  };

  const task: HandlerTask = {
    id: "task-post-rollback",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: "42",
    },
  };

  // Verify: should NOT route through Docker runner after rollback
  assert.equal(shouldUseDockerRunnerForGithub(task, rollbackEnv), false);
});

test("canary flow: rollback — unset env var, verify bypass", () => {
  // Rollback by unsetting the env var entirely
  const rollbackEnv: HandlerEnv = {};

  const task: HandlerTask = {
    id: "task-post-rollback",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/openclaw-plugin-a2a",
      issue: "42",
    },
  };

  // Verify: should NOT route through Docker runner
  assert.equal(shouldUseDockerRunnerForGithub(task, rollbackEnv), false);
});

test("canary flow: partial rollback — disable ALL_GITHUB, keep ENABLED, verify preset-only routing", () => {
  // Partial rollback: keep runner enabled but remove ALL_GITHUB flag
  const partialRollbackEnv: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    // A2A_DOCKER_RUNNER_ALL_GITHUB intentionally absent
  };

  // Should still route openclaw-plugin-a2a tasks
  const a2aTask: HandlerTask = {
    payload: { mode: "github-propose-patch", repo: "jinwon-int/openclaw-plugin-a2a" },
  };
  assert.equal(shouldUseDockerRunnerForGithub(a2aTask, partialRollbackEnv), true);

  // Should NOT route unrelated tasks anymore
  const unrelatedTask: HandlerTask = {
    payload: { mode: "github-propose-patch", repo: "jinwon-int/a2a-docker-runner" },
  };
  assert.equal(shouldUseDockerRunnerForGithub(unrelatedTask, partialRollbackEnv), false);
});

test("integration flow: blocked task round-trip (no token, no PR, failure)", () => {
  const task: HandlerTask = {
    id: "blocked-task",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/test-repo",
      issue: "1",
    },
  };

  assert.equal(shouldUseDockerRunnerForGithub(task, baseEnv), false);

  // Even though routing was false (no matching preset), let's test the evidence
  // path for a scenario where routing DID happen but execution failed.
  const raw = JSON.stringify({
    ok: false,
    taskId: "blocked-task",
    status: "failed",
    workDir: "/tmp",
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "npm ERR! build failed",
    artifacts: [],
    error: "npm ERR! build failed",
    github: { blockCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-999" },
  });

  const parsed = parseRunnerOutput(raw);
  const evidence = extractGitHubEvidence(parsed);
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-999");

  const handlerResult = buildHandlerResult(parsed, task, "sogyo");
  assert.equal(handlerResult.status, "blocked");
});

test("integration flow: timeout round-trip", () => {
  const task: HandlerTask = {
    id: "timeout-task",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/heavy-repo",
    },
  };

  const raw = JSON.stringify({
    ok: false,
    taskId: "timeout-task",
    status: "timeout",
    workDir: "/tmp",
    exitCode: null,
    signal: "SIGKILL",
    stdout: "partial output before timeout",
    stderr: "container timed out",
    artifacts: [],
    error: "timeout exceeded",
  });

  const parsed = parseRunnerOutput(raw);
  assert.equal(parsed.status, "timeout");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.signal, "SIGKILL");

  const evidence = extractGitHubEvidence(parsed);
  assert.equal(evidence, null); // No evidence → timeout with no fallback

  const handlerResult = buildHandlerResult(parsed, task, "sogyo");
  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.summary.includes("timeout-task"), true);
  assert.equal(handlerResult.risks[0], "runner completed without structured GitHub evidence");
});

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic mapping contract: status strings and Korean summary
// ═══════════════════════════════════════════════════════════════════════════

test("contract: buildHandlerResult always returns valid status enum", () => {
  const testCases: Array<{ result: RawRunnerOutput; expectedStatus: string }> = [
    {
      result: {
        ok: true, taskId: "t", status: "completed", workDir: "/tmp",
        stdout: "", stderr: "", artifacts: [],
        github: { prUrl: "https://example.com/pr/1" },
      },
      expectedStatus: "pr_opened",
    },
    {
      result: {
        ok: false, taskId: "t", status: "failed", workDir: "/tmp",
        stdout: "", stderr: "", artifacts: [],
        github: { blockCommentUrl: "https://example.com/issue/1#c-1" },
      },
      expectedStatus: "blocked",
    },
    {
      result: {
        ok: true, taskId: "t", status: "completed", workDir: "/tmp",
        stdout: "", stderr: "", artifacts: [],
        github: { doneCommentUrl: "https://example.com/issue/1#c-2" },
      },
      expectedStatus: "done",
    },
    {
      result: {
        ok: true, taskId: "t", status: "completed", workDir: "/tmp",
        stdout: "", stderr: "", artifacts: [],
      },
      expectedStatus: "blocked",
    },
  ];

  for (const { result, expectedStatus } of testCases) {
    const hr = buildHandlerResult(result, { id: "t" }, "sogyo");
    assert.equal(hr.status, expectedStatus);
  }
});

test("contract: HandlerResult summary is Korean when task has Korean context", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "한글-태스크", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/1" },
  };
  const handlerResult = buildHandlerResult(result, { id: "한글-태스크" }, "sogyo");
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.summary.includes("한글-태스크"), true);
});

test("contract: HandlerResult always has tests array (non-empty for evidence)", () => {
  const withEvidence: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://example.com/pull/1" },
  };
  const hr1 = buildHandlerResult(withEvidence, { id: "t1" }, "sogyo");
  assert.ok(Array.isArray(hr1.tests));
  assert.ok(hr1.tests.length > 0);

  const withoutEvidence: RawRunnerOutput = {
    ok: true, taskId: "t2", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
  };
  const hr2 = buildHandlerResult(withoutEvidence, { id: "t2" }, "sogyo");
  assert.ok(Array.isArray(hr2.tests));
});

test("contract: HandlerResult always has risks array", () => {
  const withPR: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { prUrl: "https://example.com/pull/1" },
  };
  const hr1 = buildHandlerResult(withPR, { id: "t1" }, "sogyo");
  assert.ok(Array.isArray(hr1.risks));
  assert.equal(hr1.risks.length, 0); // no risks when PR exists

  const withoutEvidence: RawRunnerOutput = {
    ok: true, taskId: "t2", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
  };
  const hr2 = buildHandlerResult(withoutEvidence, { id: "t2" }, "sogyo");
  assert.ok(Array.isArray(hr2.risks));
  assert.ok(hr2.risks.length > 0); // risks when no evidence
});
