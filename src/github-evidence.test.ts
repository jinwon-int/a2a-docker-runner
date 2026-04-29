import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubEvidence } from "./github-evidence.js";
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
  repo: "jinon86/test-repo",
  repos: [],
  commands: [],
  issueUrl: "https://github.com/jinon86/test-repo/issues/1",
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
    exitCode: 0, signal: null, stdout: "PR created: https://github.com/jinon86/test-repo/pull/42", stderr: "", artifacts: [],
    prUrl: "https://github.com/jinon86/test-repo/pull/42",
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinon86/test-repo/pull/42");
});

test("extracts prUrl into evidence on success", async () => {
  const task = { ...baseTask };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null,
    stdout: "Pushed and created https://github.com/jinon86/test-repo/pull/99", stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinon86/test-repo/pull/99",
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.prUrl, "https://github.com/jinon86/test-repo/pull/99");
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
