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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isGithubProposePatchTask,
  isEnvTruthy,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
  buildOperatorTaskReportEvidence,
  buildTerminalEvidenceEvent,
  decideTerminalEvidenceAck,
  buildTerminalAckDecision,
} from "./integration.js";
import type { HandlerTask, HandlerEnv, HandlerResult, RawRunnerOutput, TerminalAckDecision, TerminalEvidenceEvent, TerminalEvidenceKind, TerminalEvidenceStatus } from "./integration.js";

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
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/seoyoon-family-wiki",
      baseBranch: "master",
      issue: "42",
      issueUrl: "https://github.com/jinwon-int/seoyoon-family-wiki/issues/42",
      title: "Evidence contract proof",
      focus: "Include safe terminal notice context.",
      worker: "bangtong",
    },
  };
  const result = buildRunnerTaskFromHandlerPayload(task, baseEnv);

  assert.equal(result.id, "task-def");
  assert.equal(result.repo, "jinwon-int/seoyoon-family-wiki");
  assert.equal(result.baseBranch, "master");
  assert.equal(result.issueUrl, "https://github.com/jinwon-int/seoyoon-family-wiki/issues/42");
  assert.equal(result.issueTitle, "Evidence contract proof");
  assert.equal(result.taskBrief, "Include safe terminal notice context.");
  assert.equal(result.requestedBy, "bangtong");
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
  assert.equal(evidence?.outcome, "block");
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-123");
});

test("extractGitHubEvidence: accepts canonical blockUrl envelope", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t1", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "error", artifacts: [],
    github: {
      schemaVersion: "a2a.runner.github-evidence.v1",
      repo: "jinwon-int/repo",
      issue: "jinwon-int/repo#5",
      taskId: "t1",
      outcome: "block",
      blockUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123",
      validation: { status: "failed", exitCode: 1, timedOut: false, artifactCount: 1 },
    },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.schemaVersion, "a2a.runner.github-evidence.v1");
  assert.equal(evidence?.blockUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-123");
  assert.equal(evidence?.blockCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-123");
});

test("extractGitHubEvidence: extracts receipt-gated doneCommentUrl from github evidence block", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: {
      taskId: "t1",
      issueUrl: "https://github.com/jinwon-int/repo/issues/5",
      doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456",
      validation: { status: "completed", exitCode: 0, timedOut: false, artifactCount: 0 },
      safetyState: { noLiveProviderSend: true, terminalAck: "requires_operator_receipt", providerSendIsReceiptEvidence: false },
    },
  };
  const evidence = extractGitHubEvidence(result);
  assert.ok(evidence);
  assert.equal(evidence?.doneCommentUrl, "https://github.com/jinwon-int/repo/issues/5#issuecomment-456");
});

test("extractGitHubEvidence: keeps legacy Done comment URLs for backwards-compatible receipt gates", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: { taskId: "t1", issueUrl: "https://github.com/jinwon-int/repo/issues/5", doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.equal(evidence?.outcome, "done");
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

test("extractGitHubEvidence: ignores Done evidence from failed runner output", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t2", status: "failed", workDir: "/tmp",
    stdout: "", stderr: "error", artifacts: [],
    github: { doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456" },
  };
  const evidence = extractGitHubEvidence(result);
  assert.equal(evidence, null);
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

test("buildHandlerResult: status done when receipt-gated doneCommentUrl present and no prUrl/block", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t1", status: "completed", workDir: "/tmp",
    stdout: "", stderr: "", artifacts: [],
    github: {
      taskId: "t1",
      issueUrl: "https://github.com/jinwon-int/repo/issues/5",
      doneCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-456",
      validation: { status: "completed", exitCode: 0, timedOut: false, artifactCount: 0 },
      safetyState: { noLiveProviderSend: true, terminalAck: "requires_operator_receipt", providerSendIsReceiptEvidence: false },
    },
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
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      status: "done",
      summary: "Runner done with evidence.",
      evidence: [],
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

// ═══════════════════════════════════════════════════════════════════════════
// Terminal Brief evidence event — compact broker SSE/webhook payload
// ═══════════════════════════════════════════════════════════════════════════

interface TerminalEvidenceFixture {
  handlerTask: HandlerTask;
  runnerOutput: RawRunnerOutput;
  worker: string;
  emittedAt: string;
  expectedTerminalEvidence: TerminalEvidenceEvent;
  telegramDryRun: {
    safe: boolean;
    mustNotContain: string[];
  };
  authAndRateLimitSafety: string[];
  operatorRunbook: string[];
  activeTargets: string[];
  excludeNodes: string[];
}

interface TerminalEvidenceR2Scenario {
  name: string;
  handlerTask: HandlerTask;
  runnerOutput: RawRunnerOutput;
  expectedTerminalEvidence: TerminalEvidenceEvent;
  expectedAckDecision?: {
    terminalAckAllowed: boolean;
    reason: string;
  };
}

interface TerminalEvidenceR2Fixture {
  worker: string;
  emittedAt: string;
  receiptAckPolicy: {
    terminalAckRequiresReceipt: boolean;
    mustNotAckFrom: string[];
    safe: boolean;
  };
  scenarios: TerminalEvidenceR2Scenario[];
  safeEvidenceMustNotContain: string[];
}

interface BudgetLimitedFixture {
  worker: string;
  emittedAt: string;
  handlerTask: HandlerTask;
  runnerOutput: RawRunnerOutput;
}

function loadTerminalEvidenceFixture(): TerminalEvidenceFixture {
  const raw = readFileSync(new URL("../examples/runner-terminal-evidence-fixture.json", import.meta.url), "utf8");
  return JSON.parse(raw) as TerminalEvidenceFixture;
}

function loadTerminalEvidenceR2Fixture(): TerminalEvidenceR2Fixture {
  const raw = readFileSync(new URL("../examples/runner-terminal-evidence-r2-nosuk-fixture.json", import.meta.url), "utf8");
  return JSON.parse(raw) as TerminalEvidenceR2Fixture;
}

function loadBudgetLimitedFixture(): BudgetLimitedFixture {
  const raw = readFileSync(new URL("../examples/runner-budget-limited-fixture.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BudgetLimitedFixture;
}

test("runner-to-broker fixture: converts runner output into expected terminal evidence event", () => {
  const fixture = loadTerminalEvidenceFixture();
  const parsed = parseRunnerOutput(JSON.stringify(fixture.runnerOutput));

  const event = buildTerminalEvidenceEvent(
    parsed,
    fixture.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(event)), fixture.expectedTerminalEvidence);

  const handlerResult = buildHandlerResult(parsed, fixture.handlerTask, fixture.worker);
  assert.equal(handlerResult.status, "pr_opened");
  assert.equal(handlerResult.prUrl, fixture.expectedTerminalEvidence.prUrl);
  assert.equal(handlerResult.terminalEvidence.eventId, fixture.expectedTerminalEvidence.eventId);
  assert.equal(handlerResult.terminalEvidence.dedupeKey, fixture.expectedTerminalEvidence.dedupeKey);
});

test("runner-to-broker fixture: terminal alert is Telegram-safe and replay-safe", () => {
  const fixture = loadTerminalEvidenceFixture();
  const alertPayload = JSON.stringify(fixture.expectedTerminalEvidence.alert);
  const terminalPayload = JSON.stringify(fixture.expectedTerminalEvidence);

  assert.equal(fixture.telegramDryRun.safe, true);
  assert.equal(fixture.expectedTerminalEvidence.dedupeKey, fixture.expectedTerminalEvidence.eventId);
  assert.ok(fixture.authAndRateLimitSafety.some((line) => /dedupeKey/.test(line)));
  assert.ok(fixture.operatorRunbook.some((line) => /do not live deploy/i.test(line)));

  for (const forbidden of fixture.telegramDryRun.mustNotContain) {
    assert.ok(!alertPayload.includes(forbidden), `alert payload contains forbidden value: ${forbidden}`);
    if (forbidden !== "stdout" && forbidden !== "stderr") {
      assert.ok(!terminalPayload.includes(forbidden), `terminal payload contains forbidden value: ${forbidden}`);
    }
  }

  for (const target of ["bangtong", "dungae", "sogyo", "nosuk"]) {
    assert.ok(fixture.activeTargets.includes(target), `missing active target ${target}`);
  }
  assert.ok(fixture.excludeNodes.includes("yukson"), "yukson must stay excluded from the fixture runbook");
});

test("budget-limited fixture: validates continuation contract and does not map Done evidence to done", () => {
  const fixture = loadBudgetLimitedFixture();
  const parsed = parseRunnerOutput(JSON.stringify(fixture.runnerOutput));

  assert.equal(parsed.artifactManifest?.status, "budget_limited");
  assert.equal(parsed.resultSummary?.budget?.limitKind, "time");
  assert.equal(parsed.resultSummary?.continuation?.requiresApproval, true);

  const handlerResult = buildHandlerResult(parsed, fixture.handlerTask, fixture.worker);
  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.doneCommentUrl, undefined);
  assert.match(handlerResult.summary, /budget limit/i);
  assert.match(handlerResult.nextAction ?? "", /approve one bounded continuation task/i);
  assert.ok(handlerResult.risks.some((risk) => /bounded budget was exhausted/i.test(risk)));

  const event = buildTerminalEvidenceEvent(parsed, fixture.handlerTask, fixture.worker, fixture.emittedAt);
  assert.equal(event.status, "blocked");
  assert.equal(event.evidenceKind, "BudgetLimited");
  assert.equal(event.doneUrl, undefined);
  assert.match(event.testSummary.label, /budget-limited continuation evidence/);
  assert.match(event.reason ?? "", /approve one bounded continuation task/i);
});

test("parseRunnerOutput: rejects unsafe continuation without approval", () => {
  const fixture = loadBudgetLimitedFixture();
  const unsafe = structuredClone(fixture.runnerOutput);
  assert.ok(unsafe.resultSummary);
  unsafe.resultSummary = {
    ...unsafe.resultSummary,
    continuation: {
      recommended: true,
      nextPrompt: "continue",
      requiresApproval: false as true,
    },
  };

  assert.throws(() => parseRunnerOutput(JSON.stringify(unsafe)), /must require approval/);
});

test("r2 nosuk fixture: covers compact PR/Done/Block terminal evidence", () => {
  const fixture = loadTerminalEvidenceR2Fixture();
  const expectedKinds = new Set(["PR", "Done", "Block"]);

  assert.equal(fixture.worker, "nosuk");
  assert.equal(fixture.receiptAckPolicy.safe, true);

  for (const scenario of fixture.scenarios) {
    const parsed = parseRunnerOutput(JSON.stringify(scenario.runnerOutput));
    const event = buildTerminalEvidenceEvent(parsed, scenario.handlerTask, fixture.worker, fixture.emittedAt);

    assert.deepEqual(JSON.parse(JSON.stringify(event)), scenario.expectedTerminalEvidence, scenario.name);
    expectedKinds.delete(event.evidenceKind);
    assert.equal(event.dedupeKey, event.eventId, scenario.name);
    assert.ok(event.alert.body.length <= 360, scenario.name);

    const terminalPayload = JSON.stringify(event);
    for (const forbidden of fixture.safeEvidenceMustNotContain) {
      assert.ok(!terminalPayload.includes(forbidden), `${scenario.name} leaked forbidden value: ${forbidden}`);
    }
  }

  assert.deepEqual([...expectedKinds], []);
});

test("r2 nosuk fixture: send success alone remains blocked without receipt evidence", () => {
  const fixture = loadTerminalEvidenceR2Fixture();
  const scenario = fixture.scenarios.find((entry) => entry.expectedAckDecision?.terminalAckAllowed === false);
  assert.ok(scenario, "fixture must include a send-success-only negative ack scenario");
  assert.equal(fixture.receiptAckPolicy.terminalAckRequiresReceipt, true);
  assert.ok(fixture.receiptAckPolicy.mustNotAckFrom.some((line) => /send success/i.test(line)));

  const parsed = parseRunnerOutput(JSON.stringify(scenario.runnerOutput));
  const handlerResult = buildHandlerResult(parsed, scenario.handlerTask, fixture.worker);

  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.prUrl, undefined);
  assert.equal(handlerResult.doneCommentUrl, undefined);
  assert.equal(handlerResult.blockCommentUrl, undefined);
  assert.equal(handlerResult.terminalEvidence.status, "blocked");
  assert.equal(handlerResult.terminalEvidence.evidenceKind, "MissingEvidence");
  assert.equal(handlerResult.terminalEvidence.prUrl, undefined);
  assert.equal(handlerResult.terminalEvidence.doneUrl, undefined);
  assert.equal(handlerResult.terminalEvidence.blockUrl, undefined);
  assert.equal(scenario.expectedAckDecision?.terminalAckAllowed, false);
  assert.match(scenario.expectedAckDecision?.reason ?? "", /not receipt evidence/i);
});

test("buildTerminalEvidenceEvent: emits compact safe PR evidence without raw logs or private paths", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "task-79", status: "completed", workDir: "/private/runner/work/task-79/run-1",
    stdout: "raw log with token=secret should not appear", stderr: "raw stderr should not appear", artifacts: ["/private/runner/work/task-79/run-1/artifacts/summary.txt"],
    resultSummary: {
      exitCode: 0, signal: null, timedOut: false,
      stdout: "bounded stdout", stderr: "bounded stderr",
      stdoutTruncated: false, stderrTruncated: false, artifactCount: 1, manifestPath: "artifacts/manifest.json",
      runnerBuild: {
        version: "0.1.0",
        source: "https://github.com/jinwon-int/a2a-docker-runner",
        revision: "abc123",
        builtAt: "2026-05-01T00:00:00Z",
        image: "ghcr.io/jinwon-int/a2a-docker-runner:abc123",
      },
    },
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/79" },
  };
  const event = buildTerminalEvidenceEvent(
    result,
    { id: "task-79", payload: { repo: "jinwon-int/repo", issue: "79" } },
    "sogyo",
    "2026-05-01T12:00:00.000Z",
  );

  assert.equal(event.schemaVersion, "a2a.runner.terminal-evidence.v1");
  assert.equal(event.eventId, "a2a-terminal:task-79:succeeded:PR:https://github.com/jinwon-int/repo/pull/79");
  assert.equal(event.dedupeKey, event.eventId);
  assert.equal(event.status, "succeeded");
  assert.equal(event.evidenceKind, "PR");
  assert.equal(event.worker, "sogyo");
  assert.equal(event.repo, "jinwon-int/repo");
  assert.equal(event.issue, "https://github.com/jinwon-int/repo/issues/79");
  assert.equal(event.prUrl, "https://github.com/jinwon-int/repo/pull/79");
  assert.deepEqual(event.alert, {
    title: "A2A PR: jinwon-int/repo",
    body: "task=task-79 · worker=sogyo · status=succeeded · exit=0 · timeout=false · artifacts=1 · issue=jinwon-int/repo#79 · reason=PR evidence is available for operator review.",
    url: "https://github.com/jinwon-int/repo/pull/79",
  });
  assert.equal(event.testSummary.label, "a2a-docker-runner completed; PR evidence; exit=0; timedOut=false; artifacts=1");
  assert.deepEqual(event.runnerBuild, {
    version: "0.1.0",
    source: "https://github.com/jinwon-int/a2a-docker-runner",
    revision: "abc123",
    builtAt: "2026-05-01T00:00:00Z",
    image: "ghcr.io/jinwon-int/a2a-docker-runner:abc123",
  });
  assert.deepEqual(event.timestamps, { emittedAt: "2026-05-01T12:00:00.000Z" });

  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes("raw log"));
  assert.ok(!serialized.includes("raw stderr"));
  assert.ok(!serialized.includes("/private/runner"));
  assert.ok(!serialized.includes("token=secret"));
});

test("buildTerminalEvidenceEvent: includes safe task context required for terminal notices", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "task-120", status: "completed", workDir: "/private/runner/task-120",
    exitCode: 0, signal: null,
    stdout: "raw logs omitted", stderr: "", artifacts: ["artifacts/summary.txt"],
    resultSummary: {
      exitCode: 0, signal: null, timedOut: false,
      stdout: "validation passed", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      artifactCount: 1, manifestPath: "artifacts/manifest.json",
    },
    github: {
      schemaVersion: "a2a.runner.github-evidence.v1",
      taskId: "task-120",
      repo: "jinwon-int/a2a-docker-runner",
      issue: "jinwon-int/a2a-docker-runner#120",
      outcome: "done",
      doneUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/120#issuecomment-done",
      doneCommentUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/120#issuecomment-done",
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/120",
      validation: { status: "completed", exitCode: 0, timedOut: false, artifactCount: 1 },
      safetyState: { noLiveProviderSend: true, terminalAck: "requires_operator_receipt", providerSendIsReceiptEvidence: false },
      issueTitle: "A2A release dry-run: runner evidence contract proof",
      taskBrief: "Prove terminal evidence has enough structured context and fails closed.",
    },
  };

  const event = buildTerminalEvidenceEvent(
    result,
    {
      id: "task-120",
      payload: {
        repo: "jinwon-int/a2a-docker-runner",
        issue: "120",
        title: "A2A release dry-run: runner evidence contract proof",
        focus: "Prove terminal evidence has enough structured context and fails closed.",
      },
    },
    "bangtong",
    "2026-05-04T02:25:11.000Z",
  );

  assert.equal(event.taskId, "task-120");
  assert.equal(event.worker, "bangtong");
  assert.equal(event.repo, "jinwon-int/a2a-docker-runner");
  assert.equal(event.issue, "https://github.com/jinwon-int/a2a-docker-runner/issues/120");
  assert.equal(event.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/120");
  assert.deepEqual(event.safetyState, { noLiveProviderSend: true, terminalAck: "requires_operator_receipt", providerSendIsReceiptEvidence: false });
  assert.equal(event.issueTitle, "A2A release dry-run: runner evidence contract proof");
  assert.equal(event.taskBrief, "Prove terminal evidence has enough structured context and fails closed.");
  assert.equal(event.doneUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/120#issuecomment-done");
  assert.equal(event.testSummary.exitCode, 0);
  assert.equal(event.testSummary.artifactCount, 1);
  assert.match(event.alert.body, /title=A2A release dry-run/);
  assert.ok(!JSON.stringify(event).includes("raw logs omitted"));
  assert.ok(!JSON.stringify(event).includes("/private/runner"));
});

test("buildTerminalEvidenceEvent: includes short Done reason and issue URL", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "task-done", status: "completed", workDir: "/tmp/work",
    stdout: "large log that should not be copied", stderr: "", artifacts: [],
    resultSummary: {
      exitCode: 0, signal: null, timedOut: false,
      stdout: "bounded stdout", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      artifactCount: 0, manifestPath: "artifacts/manifest.json",
    },
    github: {
      taskId: "task-done",
      issueUrl: "https://github.com/jinwon-int/repo/issues/83",
      doneCommentUrl: "https://github.com/jinwon-int/repo/issues/83#issuecomment-2",
      validation: { status: "completed", exitCode: 0, timedOut: false, artifactCount: 0 },
      safetyState: { noLiveProviderSend: true, terminalAck: "requires_operator_receipt", providerSendIsReceiptEvidence: false },
    },
  };

  const event = buildTerminalEvidenceEvent(
    result,
    { id: "task-done", payload: { repo: "jinwon-int/repo", issueUrl: "https://github.com/jinwon-int/repo/issues/83" } },
    "sogyo",
    "2026-05-01T12:30:00.000Z",
  );

  assert.equal(event.status, "succeeded");
  assert.equal(event.evidenceKind, "Done");
  assert.equal(event.issue, "https://github.com/jinwon-int/repo/issues/83");
  assert.equal(event.issueUrl, "https://github.com/jinwon-int/repo/issues/83");
  assert.deepEqual(event.safetyState, { noLiveProviderSend: true, terminalAck: "requires_operator_receipt", providerSendIsReceiptEvidence: false });
  assert.equal(event.doneUrl, "https://github.com/jinwon-int/repo/issues/83#issuecomment-2");
  assert.equal(event.alert.title, "A2A Done: jinwon-int/repo");
  assert.equal(event.alert.url, "https://github.com/jinwon-int/repo/issues/83#issuecomment-2");
  assert.equal(event.reason, "Done evidence was posted because no PR was needed.");
  assert.ok(!JSON.stringify(event).includes("large log"));
});

test("buildTerminalEvidenceEvent: timeout missing-evidence event is distinguished from generic missing evidence", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "task-timeout", status: "timeout", workDir: "/tmp/work",
    stdout: "raw stdout", stderr: "raw stderr", artifacts: [],
    resultSummary: {
      exitCode: null, signal: "SIGTERM", timedOut: true,
      stdout: "bounded stdout", stderr: "bounded stderr",
      stdoutTruncated: false, stderrTruncated: false, artifactCount: 0, manifestPath: "artifacts/manifest.json",
    },
  };

  const event = buildTerminalEvidenceEvent(
    result,
    { id: "task-timeout", payload: { repo: "jinwon-int/repo", issue: "85" } },
    "sogyo",
    "2026-05-01T13:00:00.000Z",
  );

  assert.equal(event.status, "cancelled");
  assert.equal(event.evidenceKind, "TimedOut");
  assert.equal(event.reason, "Runner timed out before producing PR/Done/Block evidence.");
  assert.match(event.testSummary.label, /missing terminal evidence/);
  assert.equal(event.alert.title, "A2A Timeout: jinwon-int/repo");
  assert.ok(!JSON.stringify(event).includes("raw stdout"));
  assert.ok(!JSON.stringify(event).includes("raw stderr"));
});

test("buildTerminalEvidenceEvent: failed missing-evidence event keeps reason short and omits raw logs", () => {
  const longError = "fatal: /private/work/run failed token=secret ".concat("very noisy detail ".repeat(80));
  const result: RawRunnerOutput = {
    ok: false, taskId: "task-failed", status: "failed", workDir: "/private/work",
    stdout: "raw stdout ".repeat(200), stderr: "raw stderr ".repeat(200), artifacts: [],
    error: longError,
  };

  const event = buildTerminalEvidenceEvent(
    result,
    { id: "task-failed", payload: { repo: "jinwon-int/repo", issue: "84" } },
    "sogyo",
    "2026-05-01T12:45:00.000Z",
  );

  assert.equal(event.status, "failed");
  assert.equal(event.evidenceKind, "MissingEvidence");
  assert.equal(event.reason?.startsWith("fatal: <path> failed token=<redacted> very noisy detail"), true);
  assert.ok((event.reason?.length ?? 0) <= 180);
  assert.equal(event.alert.title, "A2A Needs review: jinwon-int/repo");
  assert.ok(event.alert.body.includes("status=failed"));
  assert.ok(event.alert.body.length <= 360);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes("raw stdout"));
  assert.ok(!serialized.includes("raw stderr"));
  assert.ok(!serialized.includes("/private/work"));
  assert.ok(!serialized.includes("token=secret"));
});

interface TerminalAckSmokeFixture {
  description: string;
  worker: string;
  emittedAt: string;
  cases: Array<{
    name: string;
    handlerTask: HandlerTask;
    runnerOutput: RawRunnerOutput;
    receipt?: { operatorVisible: boolean; channel?: string; receiptId?: string; url?: string; deliveredAt?: string };
    providerSendSuccessOnly?: boolean;
    expectedAck: TerminalAckDecision;
  }>;
  safety: { mustNotContain: string[] };
}

interface TelegramTerminalNotificationSmokeFixture {
  description: string;
  worker: string;
  emittedAt: string;
  handlerTask: HandlerTask;
  runnerOutput: RawRunnerOutput;
  steps: Array<{
    name: string;
    providerSendOk: boolean;
    receipt?: { operatorVisible: boolean; channel?: string; receiptId?: string; url?: string; deliveredAt?: string };
    expectedAck: Pick<TerminalAckDecision, "acknowledged" | "cursorComplete" | "reason">;
  }>;
  safety: { mustNotContain: string[] };
}

interface TerminalBriefReceiptR4Fixture {
  run: string;
  issue: string;
  parent: string;
  worker: string;
  emittedAt: string;
  canonicalCloseout: {
    allowedEvidenceKinds: TerminalEvidenceKind[];
    terminalAckRequiresOperatorVisibleReceipt: boolean;
    providerSendSuccessIsReceiptEvidence: boolean;
    noLiveProviderSend: boolean;
    terminalOutboxAckPerformed: boolean;
  };
  cases: Array<{
    name: string;
    terminalOutboxId: string;
    runId: string;
    providerSendSuccessOnly?: boolean;
    handlerTask: HandlerTask;
    runnerOutput: RawRunnerOutput;
    receipt?: { operatorVisible: boolean; channel?: string; receiptId?: string; url?: string; deliveredAt?: string };
    expected: Pick<TerminalAckDecision, "evidenceKind" | "acknowledged" | "cursorComplete"> & { status: TerminalEvidenceStatus };
  }>;
  mustNotContain: string[];
}

function loadTerminalAckSmokeFixture(): TerminalAckSmokeFixture {
  const raw = readFileSync(new URL("../examples/runner-terminal-ack-smoke.json", import.meta.url), "utf8");
  return JSON.parse(raw) as TerminalAckSmokeFixture;
}

function loadTelegramTerminalNotificationSmokeFixture(): TelegramTerminalNotificationSmokeFixture {
  const raw = readFileSync(new URL("../examples/runner-telegram-terminal-notification-smoke.json", import.meta.url), "utf8");
  return JSON.parse(raw) as TelegramTerminalNotificationSmokeFixture;
}

function loadTerminalBriefReceiptR4Fixture(): TerminalBriefReceiptR4Fixture {
  const raw = readFileSync(new URL("../examples/terminal-brief-receipt-r4-canonical.json", import.meta.url), "utf8");
  return JSON.parse(raw) as TerminalBriefReceiptR4Fixture;
}

test("terminal ack smoke fixture: PR/Done/Block require operator-visible receipt", () => {
  const fixture = loadTerminalAckSmokeFixture();

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );
    const decision = buildTerminalAckDecision(event, entry.receipt);

    assert.deepEqual(JSON.parse(JSON.stringify(decision)), entry.expectedAck, entry.name);
  }
});

test("terminal ack smoke fixture: provider send success alone never completes cursor", () => {
  const fixture = loadTerminalAckSmokeFixture();
  const noReceiptCase = fixture.cases.find((entry) => entry.providerSendSuccessOnly);
  assert.ok(noReceiptCase, "fixture must include provider-send-success-only case");

  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(noReceiptCase.runnerOutput)),
    noReceiptCase.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );
  const decision = buildTerminalAckDecision(event, { operatorVisible: false, channel: "telegram" });

  assert.equal(decision.acknowledged, false);
  assert.equal(decision.cursorComplete, false);
  assert.equal(decision.reason, "operator-visible receipt required before terminal ack");

  const serialized = JSON.stringify({ event, decision });
  for (const forbidden of fixture.safety.mustNotContain) {
    assert.ok(!serialized.includes(forbidden), `terminal ack smoke leaked forbidden value: ${forbidden}`);
  }
});

test("Telegram terminal notification smoke: ACK waits for operator-visible receipt", () => {
  const fixture = loadTelegramTerminalNotificationSmokeFixture();
  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(fixture.runnerOutput)),
    fixture.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );

  const decisions = fixture.steps.map((step) => ({ step, decision: buildTerminalAckDecision(event, step.receipt) }));
  assert.ok(decisions.some(({ decision }) => decision.acknowledged === false), "must include blocked pre-receipt step");
  assert.ok(decisions.some(({ decision }) => decision.acknowledged === true), "must include receipt-confirmed ACK step");

  for (const { step, decision } of decisions) {
    assert.equal(decision.acknowledged, step.expectedAck.acknowledged, step.name);
    assert.equal(decision.cursorComplete, step.expectedAck.cursorComplete, step.name);
    assert.equal(decision.reason, step.expectedAck.reason, step.name);

    if (step.receipt) {
      assert.equal(step.receipt.channel, "telegram", step.name);
      assert.ok(step.receipt.receiptId || step.receipt.url || step.receipt.deliveredAt, step.name);
    } else {
      assert.equal(step.providerSendOk, true, step.name);
    }
  }

  const serialized = JSON.stringify({ event, decisions: decisions.map(({ decision }) => decision) });
  for (const forbidden of fixture.safety.mustNotContain) {
    assert.ok(!serialized.includes(forbidden), `Telegram terminal notification smoke leaked forbidden value: ${forbidden}`);
  }
});

test("Telegram terminal notification smoke harness script passes without live Telegram", () => {
  const output = execFileSync(process.execPath, ["scripts/telegram-terminal-notification-smoke.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const result = JSON.parse(output) as { ok: boolean; decisions: Array<{ acknowledged: boolean }> };
  assert.equal(result.ok, true);
  assert.ok(result.decisions.some((entry) => entry.acknowledged === false));
  assert.ok(result.decisions.some((entry) => entry.acknowledged === true));
});

test("R4 canonical Terminal Brief receipt fixture requires operator-visible receipt", () => {
  const fixture = loadTerminalBriefReceiptR4Fixture();
  const observedKinds = new Set<TerminalEvidenceKind>();

  assert.equal(fixture.run, "terminal-brief-receipt-r4-canonical-20260506T004710Z");
  assert.equal(fixture.issue, "https://github.com/jinwon-int/a2a-docker-runner/issues/154");
  assert.equal(fixture.parent, "https://github.com/jinwon-int/a2a-broker/issues/383");
  assert.equal(fixture.canonicalCloseout.terminalAckRequiresOperatorVisibleReceipt, true);
  assert.equal(fixture.canonicalCloseout.providerSendSuccessIsReceiptEvidence, false);
  assert.equal(fixture.canonicalCloseout.noLiveProviderSend, true);
  assert.equal(fixture.canonicalCloseout.terminalOutboxAckPerformed, false);

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );
    const decision = buildTerminalAckDecision(event, entry.receipt);

    assert.match(entry.terminalOutboxId, /^terminal-outbox-r4-/, entry.name);
    assert.equal(entry.runId, fixture.run, entry.name);
    observedKinds.add(event.evidenceKind);
    assert.equal(event.issueUrl, fixture.issue, entry.name);
    assert.equal(event.safetyState.noLiveProviderSend, true, entry.name);
    assert.equal(event.safetyState.terminalAck, "requires_operator_receipt", entry.name);
    assert.equal(event.safetyState.providerSendIsReceiptEvidence, false, entry.name);
    assert.equal(event.status, entry.expected.status, entry.name);
    assert.equal(event.evidenceKind, entry.expected.evidenceKind, entry.name);
    assert.equal(decision.acknowledged, entry.expected.acknowledged, entry.name);
    assert.equal(decision.cursorComplete, entry.expected.cursorComplete, entry.name);

    if (entry.providerSendSuccessOnly) {
      assert.equal(decision.reason, "operator-visible receipt required before terminal ack", entry.name);
      assert.equal(decision.receipt, undefined, entry.name);
    }
  }

  for (const kind of fixture.canonicalCloseout.allowedEvidenceKinds) {
    assert.ok(observedKinds.has(kind), `missing canonical evidence kind ${kind}`);
  }

  const serialized = JSON.stringify(fixture.cases.map((entry) => {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );
    const decision = buildTerminalAckDecision(event, entry.receipt);
    return { event, decision };
  }));
  for (const forbidden of fixture.mustNotContain) {
    assert.ok(!serialized.includes(forbidden), `R4 terminal receipt fixture leaked forbidden value: ${forbidden}`);
  }
});

test("R4 canonical Terminal Brief receipt smoke script emits safe artifacts", () => {
  const output = execFileSync(process.execPath, ["scripts/terminal-brief-receipt-r4-smoke.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const result = JSON.parse(output) as {
    ok: boolean;
    noLiveProviderSend: boolean;
    terminalOutboxAckPerformed: boolean;
    providerSendSuccessIsReceiptEvidence: boolean;
    artifacts: Array<{ taskId: string; terminalOutboxId: string; runId: string; status: string; testSummary: object }>;
  };

  assert.equal(result.ok, true);
  assert.equal(result.noLiveProviderSend, true);
  assert.equal(result.terminalOutboxAckPerformed, false);
  assert.equal(result.providerSendSuccessIsReceiptEvidence, false);
  assert.equal(result.artifacts.length, 4);
  assert.ok(result.artifacts.every((entry) => entry.taskId && entry.terminalOutboxId && entry.runId && entry.status && entry.testSummary));
});

test("public demo artifact fixtures pass the no-live safety audit", () => {
  const output = execFileSync(process.execPath, ["scripts/public-demo-safety-audit.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const result = JSON.parse(output) as { ok: boolean; files: string[]; failures: string[] };
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.ok(result.files.includes("examples/rollout-receipt-evidence.no-live.json"));
});

test("buildHandlerResult: includes Terminal Brief evidence for broker delivery", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "task-block", status: "failed", workDir: "/tmp/work",
    stdout: "", stderr: "", artifacts: [],
    resultSummary: {
      exitCode: 1, signal: null, timedOut: false,
      stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      artifactCount: 0, manifestPath: "artifacts/manifest.json",
    },
    github: { blockCommentUrl: "https://github.com/jinwon-int/repo/issues/79#issuecomment-1" },
  };
  const handlerResult = buildHandlerResult(result, { id: "task-block", payload: { repo: "jinwon-int/repo", issueUrl: "https://github.com/jinwon-int/repo/issues/79" } }, "bangtong");

  assert.equal(handlerResult.status, "blocked");
  assert.equal(handlerResult.terminalEvidence.status, "blocked");
  assert.equal(handlerResult.terminalEvidence.evidenceKind, "Block");
  assert.equal(handlerResult.terminalEvidence.blockUrl, "https://github.com/jinwon-int/repo/issues/79#issuecomment-1");
  assert.equal(handlerResult.terminalEvidence.reason, "Block evidence was posted for operator follow-up.");
  assert.equal(handlerResult.terminalEvidence.testSummary.exitCode, 1);
});

test("buildOperatorTaskReportEvidence projects PR/Done/Block without raw logs or per-worker live sends", () => {
  const cases: Array<{ name: string; raw: RawRunnerOutput; expectedStatus: HandlerResult["status"]; expectedKind: string; expectedUrl: string }> = [
    {
      name: "PR",
      raw: {
        ok: true, taskId: "task-pr", status: "completed", workDir: "/tmp/private-pr",
        stdout: "raw token=secret PR https://github.com/jinwon-int/repo/pull/77", stderr: "", artifacts: [],
        resultSummary: { exitCode: 0, signal: null, timedOut: false, stdout: "bounded", stderr: "", stdoutTruncated: true, stderrTruncated: false, artifactCount: 1, manifestPath: "artifacts/manifest.json" },
        github: { prUrl: "https://github.com/jinwon-int/repo/pull/77" },
      },
      expectedStatus: "pr_opened",
      expectedKind: "PR",
      expectedUrl: "https://github.com/jinwon-int/repo/pull/77",
    },
    {
      name: "Done",
      raw: {
        ok: true, taskId: "task-done", status: "completed", workDir: "/tmp/private-done",
        stdout: "raw done log", stderr: "", artifacts: [],
        resultSummary: { exitCode: 0, signal: null, timedOut: false, stdout: "bounded", stderr: "", stdoutTruncated: false, stderrTruncated: false, artifactCount: 1, manifestPath: "artifacts/manifest.json" },
        github: { doneCommentUrl: "https://github.com/jinwon-int/repo/issues/135#issuecomment-done" },
      },
      expectedStatus: "done",
      expectedKind: "Done",
      expectedUrl: "https://github.com/jinwon-int/repo/issues/135#issuecomment-done",
    },
    {
      name: "Block",
      raw: {
        ok: false, taskId: "task-block", status: "failed", workDir: "/tmp/private-block",
        stdout: "raw block log", stderr: "secret stderr", artifacts: [],
        resultSummary: { exitCode: 1, signal: null, timedOut: false, stdout: "bounded", stderr: "bounded", stdoutTruncated: false, stderrTruncated: false, artifactCount: 1, manifestPath: "artifacts/manifest.json" },
        github: { blockCommentUrl: "https://github.com/jinwon-int/repo/issues/135#issuecomment-block" },
      },
      expectedStatus: "blocked",
      expectedKind: "Block",
      expectedUrl: "https://github.com/jinwon-int/repo/issues/135#issuecomment-block",
    },
  ];

  for (const entry of cases) {
    const handlerResult = buildHandlerResult(
      entry.raw,
      { id: entry.raw.taskId, payload: { repo: "jinwon-int/repo", issueUrl: "https://github.com/jinwon-int/repo/issues/135", title: `${entry.name} lane`, focus: "compact task-report evidence" } },
      "bangtong",
    );
    const report = buildOperatorTaskReportEvidence(handlerResult);

    assert.equal(report.schemaVersion, "a2a.runner.operator-task-report.v1");
    assert.equal(report.status, entry.expectedStatus, entry.name);
    assert.equal(report.evidenceKind, entry.expectedKind, entry.name);
    assert.equal(report.url, entry.expectedUrl, entry.name);
    assert.equal(report.worker, "bangtong", entry.name);
    assert.equal(report.repo, "jinwon-int/repo", entry.name);
    assert.deepEqual(Object.keys(report).sort(), Object.keys(JSON.parse(JSON.stringify(report))).sort(), entry.name);

    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes("raw "), entry.name);
    assert.ok(!serialized.includes("/tmp/private"), entry.name);
    assert.ok(!serialized.includes("secret"), entry.name);
    assert.ok(!serialized.includes("telegram"), entry.name);
    assert.ok(!serialized.includes("messageId"), entry.name);
    assert.ok(!serialized.includes("runnerRaw"), entry.name);
  }
});

test("buildHandlerResult: broker runnerRaw trims non-broker fields while preserving evidence", () => {
  const result: RawRunnerOutput = {
    ok: true, taskId: "t-diet", status: "completed", workDir: "/tmp/runner/private-workdir",
    exitCode: 0, signal: null,
    stdout: "raw stdout ".repeat(5000), stderr: "raw stderr ".repeat(5000),
    artifacts: ["/tmp/runner/private-workdir/artifacts/summary.txt"],
    artifactManifest: {
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      status: "done",
      summary: "Runner done with evidence.",
      evidence: [],
      artifacts: [
        { path: "artifacts/summary.txt", name: "summary.txt", sizeBytes: 10 },
        { path: "artifacts/patch.diff", name: "patch.diff", sizeBytes: 1000 },
      ],
    },
    resultSummary: {
      exitCode: 0, signal: null, timedOut: false,
      stdout: "bounded stdout", stderr: "bounded stderr",
      stdoutTruncated: true, stderrTruncated: true, artifactCount: 2, manifestPath: "artifacts/manifest.json",
    },
    github: { prUrl: "https://github.com/jinwon-int/repo/pull/123" },
  };

  const handlerResult = buildHandlerResult(result, { id: "t-diet" }, "sogyo");
  const runnerRaw = handlerResult.runnerRaw as Record<string, unknown>;
  const legacyPayloadSize = Buffer.byteLength(JSON.stringify({
    ...result,
    stdout: result.resultSummary?.stdout,
    stderr: result.resultSummary?.stderr,
    artifacts: ["artifacts/summary.txt", "artifacts/patch.diff"],
  }));
  const trimmedPayloadSize = Buffer.byteLength(JSON.stringify(runnerRaw));

  assert.equal(runnerRaw.github, result.github);
  assert.equal(runnerRaw.ok, true);
  assert.equal(runnerRaw.status, "completed");
  assert.equal(runnerRaw.stdout, "bounded stdout");
  assert.equal(runnerRaw.stderr, "bounded stderr");
  assert.deepEqual(runnerRaw.artifacts, ["artifacts/summary.txt", "artifacts/patch.diff"]);
  assert.equal(runnerRaw.manifestPath, "artifacts/manifest.json");
  assert.equal(Object.hasOwn(runnerRaw, "workDir"), false);
  assert.equal(Object.hasOwn(runnerRaw, "artifactManifest"), false);
  assert.equal(Object.hasOwn(runnerRaw, "resultSummary"), false);
  assert.ok(trimmedPayloadSize < legacyPayloadSize, trimmedPayloadSize + " should be smaller than " + legacyPayloadSize);
});

test("buildHandlerResult: broker runnerRaw bounds legacy raw streams when resultSummary is absent", () => {
  const result: RawRunnerOutput = {
    ok: false, taskId: "t-legacy-large", status: "failed", workDir: "/tmp",
    stdout: "legacy-stdout-".repeat(500),
    stderr: "legacy-stderr-".repeat(500),
    artifacts: [],
    error: "legacy-error-".repeat(500),
    github: { blockCommentUrl: "https://github.com/jinwon-int/repo/issues/5#issuecomment-123" },
  };
  const handlerResult = buildHandlerResult(result, { id: "t-legacy-large" }, "sogyo");
  const runnerRaw = handlerResult.runnerRaw as Record<string, string>;

  assert.ok(runnerRaw.stdout.length < result.stdout.length);
  assert.ok(runnerRaw.stderr.length < result.stderr.length);
  assert.ok(runnerRaw.error.length < result.error!.length);
  assert.match(runnerRaw.stdout, /truncated \d+ chars for broker update/);
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

// ═══════════════════════════════════════════════════════════════════════════
// R1 receipt-confirmed terminal ack smoke fixtures
// ═══════════════════════════════════════════════════════════════════════════

interface TerminalEvidenceSmokeR1Fixture {
  worker: string;
  activeTargets: string[];
  cases: Array<{
    name: string;
    runnerOutput: RawRunnerOutput;
    expected: {
      status: TerminalEvidenceEvent["status"];
      evidenceKind: TerminalEvidenceEvent["evidenceKind"];
      urlField: "prUrl" | "doneUrl" | "blockUrl";
    };
  }>;
  ackSmoke: {
    providerSendOnly: {
      providerSendOk: boolean;
      operatorVisible: boolean;
      channel: string;
    };
    operatorReceipt: {
      providerSendOk: boolean;
      operatorVisible: boolean;
      channel: string;
      messageId: string;
      receivedAt: string;
    };
  };
  mustNotContain: string[];
}

function loadTerminalEvidenceSmokeR1Fixture(): TerminalEvidenceSmokeR1Fixture {
  const raw = readFileSync(new URL("../examples/runner-terminal-evidence-smoke-r1.json", import.meta.url), "utf8");
  return JSON.parse(raw) as TerminalEvidenceSmokeR1Fixture;
}

test("R1 smoke fixture: PR/Done/Block terminal evidence stays compact and safe", () => {
  const fixture = loadTerminalEvidenceSmokeR1Fixture();
  assert.ok(fixture.activeTargets.includes("nosuk"), "R1 smoke must cover nosuk rollout target");

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      {
        id: entry.runnerOutput.taskId,
        payload: {
          repo: "jinwon-int/a2a-docker-runner",
          issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/96",
        },
      },
      fixture.worker,
      "2026-05-02T02:30:00.000Z",
    );

    assert.equal(event.status, entry.expected.status, entry.name);
    assert.equal(event.evidenceKind, entry.expected.evidenceKind, entry.name);
    assert.equal(typeof event[entry.expected.urlField], "string", entry.name);
    assert.ok(event.alert.body.length <= 360, `${entry.name} alert must be compact`);

    const serialized = JSON.stringify(event);
    for (const forbidden of fixture.mustNotContain) {
      assert.ok(!serialized.includes(forbidden), `${entry.name} leaked forbidden value: ${forbidden}`);
    }
  }
});

test("R1 smoke fixture: terminal ack requires operator-visible receipt, not provider send success", () => {
  const fixture = loadTerminalEvidenceSmokeR1Fixture();
  const entry = fixture.cases[0];
  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
    { id: entry.runnerOutput.taskId, payload: { repo: "jinwon-int/a2a-docker-runner", issue: "96" } },
    fixture.worker,
    "2026-05-02T02:30:00.000Z",
  );

  const providerOnly = decideTerminalEvidenceAck(event, {
    ...fixture.ackSmoke.providerSendOnly,
    eventId: event.eventId,
    dedupeKey: event.dedupeKey,
  });
  assert.equal(providerOnly.ack, false);
  assert.equal(providerOnly.cursorComplete, false);
  assert.match(providerOnly.reason, /operator-visible receipt/);

  const receiptConfirmed = decideTerminalEvidenceAck(event, {
    ...fixture.ackSmoke.operatorReceipt,
    eventId: event.eventId,
    dedupeKey: event.dedupeKey,
  });
  assert.equal(receiptConfirmed.ack, true);
  assert.equal(receiptConfirmed.cursorComplete, true);
  assert.equal(receiptConfirmed.reason, "operator-visible receipt confirmed");
});
