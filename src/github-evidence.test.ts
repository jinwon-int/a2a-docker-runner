import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockCommentBody, buildDoneCommentBody, collectGitHubEvidence } from "./github-evidence.js";
import type { NormalizedRunnerTask, RunnerConfig } from "./types.js";

const baseConfig: RunnerConfig = {
  rootDir: "/tmp/a2a-test",
  image: "node:22-bookworm-slim",
  defaultTimeoutMs: 15 * 60 * 1000,
};

const baseTask: NormalizedRunnerTask = {
  id: "test-task",
  intent: "propose_patch",
  mode: "github-propose-patch",
  repo: "jinwon-int/test-repo",
  repos: [],
  commands: [],
  issueUrl: "https://github.com/jinwon-int/test-repo/issues/1",
  reportLanguage: "ko",
  requestedBy: "seoseo",
};

test("returns undefined when mode is not github-evidence mode", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, mode: "chat" };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null, stdout: "", stderr: "", artifacts: [],
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.equal(evidence, undefined);
});

test("returns undefined when mode is absent", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, mode: undefined };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null, stdout: "", stderr: "", artifacts: [],
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.equal(evidence, undefined);
});

test("recognizes propose_patch mode as evidence mode", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, mode: "propose_patch" };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null, stdout: "PR created: https://github.com/jinwon-int/test-repo/pull/42", stderr: "", artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/42",
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/test-repo/pull/42");
});

test("extracts prUrl into evidence on success", async () => {
  const task = { ...baseTask };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null,
    stdout: "Pushed and created https://github.com/jinwon-int/test-repo/pull/99", stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/99",
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/test-repo/pull/99");
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("skips block comment when no issueUrl on failure", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, issueUrl: undefined };
  const result = {
    ok: false, taskId: "t1", status: "failed" as const, workDir: "/tmp",
    exitCode: 1, signal: null, stdout: "", stderr: "build error", artifacts: [],
    error: "build error",
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("parseIssueCommentApiUrl helper (via internal behavior)", async () => {
  // Indirect test: issueUrl with no GitHub URL pattern should not attempt API call.
  const task: NormalizedRunnerTask = { ...baseTask, issueUrl: "not-a-github-url" };
  const result = {
    ok: false, taskId: "t1", status: "failed" as const, workDir: "/tmp",
    exitCode: 1, signal: null, stdout: "", stderr: "fail", artifacts: [],
    error: "fail",
  };
  // No token → no block comment → evidence without blockCommentUrl.
  const evidence = await collectGitHubEvidence({ ...baseConfig, githubTokenFile: undefined }, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("missing patch command is not treated as Done evidence", async () => {
  const task: NormalizedRunnerTask = { ...baseTask };
  const result = {
    ok: true,
    taskId: "t1",
    status: "completed" as const,
    workDir: "/tmp",
    exitCode: 0,
    signal: null,
    stdout: [
      "notice=no_patch_command_configured",
      "Set commandScript or commandJson in RunnerConfig to inject a coding agent.",
      "status=no_changes",
    ].join("\n"),
    stderr: "",
    artifacts: ["/tmp/artifacts/patch-command.log"],
  };

  const evidence = await collectGitHubEvidence({ ...baseConfig, githubTokenFile: undefined }, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, undefined);
  assert.equal(evidence?.doneCommentUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("block comment includes artifact manifest, command logs, reason and next action safely", () => {
  const body = buildBlockCommentBody(baseTask, {
    ok: false,
    taskId: "t1",
    status: "failed",
    workDir: "/root/.openclaw/workspace/private-task/run-1",
    exitCode: 1,
    signal: null,
    stdout: "notice=no_patch_command_configured\nusing /root/.config/gh/hosts.yml",
    stderr: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    artifacts: ["/tmp/a2a/private/run.log"],
    artifactManifest: {
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      artifacts: [{ path: "artifacts/run.log", name: "run.log", sizeBytes: 42 }],
    },
    resultSummary: {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "notice=no_patch_command_configured\nusing /root/.config/gh/hosts.yml",
      stderr: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      stdoutTruncated: false,
      stderrTruncated: false,
      artifactCount: 1,
      manifestPath: "artifacts/manifest.json",
    },
    error: "raw error from /root/.openclaw/workspace/private-task/run-1",
  });

  assert.match(body, /### 사유/);
  assert.match(body, /### 다음 조치/);
  assert.match(body, /### 아티팩트 manifest 요약/);
  assert.match(body, /### 명령 로그 요약/);
  assert.match(body, /`artifacts\/run\.log` \(42 bytes\)/);
  assert.match(body, /notice=no_patch_command_configured/);
  assert.doesNotMatch(body, /ghp_[A-Za-z0-9_]+/);
  assert.doesNotMatch(body, /\/root\/\.config\/gh/);
  assert.doesNotMatch(body, /\/root\/\.openclaw/);
});

test("done comment includes existing PR closeout context", () => {
  const body = buildDoneCommentBody({ ...baseTask, existingPrNumber: 42, repo: "jinwon-int/test-repo" }, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: "status=comment_only_done",
    stderr: "",
    artifacts: [],
  });

  assert.match(body, /## ✅ Done/);
  assert.match(body, /기존 PR\*\*: https:\/\/github\.com\/jinwon-int\/test-repo\/pull\/42/);
});

test("done comment includes manifest summary and bounded command log summary", () => {
  const body = buildDoneCommentBody(baseTask, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: "all good",
    stderr: "",
    artifacts: ["artifacts/result.json"],
    artifactManifest: {
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      artifacts: [{ path: "artifacts/result.json", name: "result.json", sizeBytes: 12 }],
    },
    resultSummary: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "all good",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      artifactCount: 1,
      manifestPath: "artifacts/manifest.json",
    },
  });

  assert.match(body, /## ✅ Done/);
  assert.match(body, /### 결과/);
  assert.match(body, /### 다음 조치/);
  assert.match(body, /### 아티팩트 manifest 요약/);
  assert.match(body, /### 명령 로그 요약/);
  assert.match(body, /`artifacts\/result\.json` \(12 bytes\)/);
  assert.match(body, /all good/);
});
