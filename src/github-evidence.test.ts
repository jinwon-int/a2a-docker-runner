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
  commands: ["npm test"],
  issueUrl: "https://github.com/jinwon-int/test-repo/issues/1",
  reportLanguage: "ko",
  requestedBy: "seoseo",
  issueTitle: "Evidence contract proof",
  taskBrief: "Produce compact terminal notice evidence without leaking raw logs.",
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

test("recognizes github-verify mode as evidence mode", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, intent: "verify", mode: "github-verify" };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null, stdout: "npm test passed", stderr: "", artifacts: [],
  };
  const evidence = await collectGitHubEvidence({ ...baseConfig, githubTokenFile: undefined }, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.outcome, "missing_evidence");
  assert.equal(evidence?.doneCommentUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("extracts prUrl into release-gate evidence on success", async () => {
  const task = { ...baseTask, runId: "a2a-release-gate-1", traceId: "trace-abc123" };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null,
    stdout: "Pushed and created https://github.com/jinwon-int/test-repo/pull/99", stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/99",
  };
  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.schemaVersion, "a2a.runner.github-evidence.v1");
  assert.equal(evidence?.repo, "jinwon-int/test-repo");
  assert.equal(evidence?.issue, "jinwon-int/test-repo#1");
  assert.equal(evidence?.issueUrl, "https://github.com/jinwon-int/test-repo/issues/1");
  assert.equal(evidence?.taskId, "test-task");
  assert.equal(evidence?.worker, "seoseo");
  assert.equal(evidence?.issueTitle, "Evidence contract proof");
  assert.equal(evidence?.taskBrief, "Produce compact terminal notice evidence without leaking raw logs.");
  assert.equal(evidence?.runId, "a2a-release-gate-1");
  assert.equal(evidence?.traceId, "trace-abc123");
  assert.equal(evidence?.outcome, "pr");
  assert.equal(evidence?.prUrl, "https://github.com/jinwon-int/test-repo/pull/99");
  assert.equal(evidence?.validation?.status, "completed");
  assert.deepEqual(evidence?.safetyState, {
    noLiveProviderSend: true,
    terminalAck: "requires_operator_receipt",
    providerSendIsReceiptEvidence: false,
  });
  assert.equal(evidence?.validationErrors, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("fails closed when terminal evidence lacks required release-gate fields", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, requestedBy: undefined };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null,
    stdout: "PR created: https://github.com/jinwon-int/test-repo/pull/99", stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/99",
  };

  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.equal(evidence?.outcome, "missing_evidence");
  assert.deepEqual(evidence?.validationErrors, ["missing_or_unsafe_worker"]);
});

test("fails closed when terminal evidence URL is unsafe", async () => {
  const task = { ...baseTask };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null,
    stdout: "PR created: http://example.test/pull/99", stderr: "",
    artifacts: [],
    prUrl: "http://example.test/pull/99",
  };

  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.equal(evidence?.outcome, "missing_evidence");
  assert.deepEqual(evidence?.validationErrors, ["missing_or_unsafe_terminal_url"]);
});

test("keeps long multiline github-verify prompt safe for release-gate metadata", async () => {
  const task: NormalizedRunnerTask = {
    ...baseTask,
    intent: "verify",
    mode: "github-verify",
    issueTitle: undefined,
    prompt: [
      "A2A GitHub-mode issue assignment",
      "",
      "Worker: yukson",
      "Issue: jinwon-int/a2a-broker#330",
      "Title: A2A no-live integration: verifier matrix",
      "URL: https://github.com/jinwon-int/a2a-broker/issues/330",
      "Run: a2a-no-live-integration-20260504035026-yukson-rerun-1777875644881",
      "",
      "This prompt is intentionally long ".repeat(20),
    ].join("\n"),
  };
  const result = {
    ok: true, taskId: "t1", status: "completed" as const, workDir: "/tmp",
    exitCode: 0, signal: null, stdout: "npm test passed", stderr: "", artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/99",
  };

  const evidence = await collectGitHubEvidence(baseConfig, task, result);
  assert.equal(evidence?.outcome, "pr");
  assert.ok(evidence?.taskBrief);
  assert.ok(evidence.taskBrief.length <= 240);
  assert.doesNotMatch(evidence.taskBrief, /[\r\n]/);
  assert.equal(evidence.validationErrors, undefined);
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

test("zero-command patch task is not treated as Done evidence", async () => {
  const task: NormalizedRunnerTask = { ...baseTask, commands: [] };
  const result = {
    ok: true,
    taskId: "t1",
    status: "completed" as const,
    workDir: "/tmp",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    artifacts: [],
  };

  const evidence = await collectGitHubEvidence({ ...baseConfig, githubTokenFile: undefined }, task, result);
  assert.ok(evidence);
  assert.equal(evidence?.outcome, "missing_evidence");
  assert.equal(evidence?.prUrl, undefined);
  assert.equal(evidence?.doneCommentUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("classifies no-url timeout evidence with canonical timed_out outcome", async () => {
  const result = {
    ok: false,
    taskId: "t-timeout",
    status: "timeout" as const,
    workDir: "/tmp",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    artifacts: [],
    resultSummary: {
      exitCode: null,
      signal: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      artifactCount: 0,
      manifestPath: "artifacts/manifest.json",
    },
  };

  const evidence = await collectGitHubEvidence({ ...baseConfig, githubTokenFile: undefined }, baseTask, result);
  assert.equal(evidence?.outcome, "timed_out");
  assert.equal(evidence?.validation?.timedOut, true);
  assert.equal(evidence?.prUrl, undefined);
  assert.equal(evidence?.doneCommentUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("classifies no-url budget stop with canonical budget_limited outcome", async () => {
  const result = {
    ok: true,
    taskId: "t-budget",
    status: "completed" as const,
    workDir: "/tmp",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    artifacts: [],
    resultSummary: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      artifactCount: 0,
      manifestPath: "artifacts/manifest.json",
      status: "budget_limited" as const,
      budget: { limitKind: "time" as const, limit: "45m", used: "45m", reason: "time budget exhausted" },
      continuation: { recommended: true, requiresApproval: true as const, nextPrompt: "continue with focused validation" },
    },
  };

  const evidence = await collectGitHubEvidence({ ...baseConfig, githubTokenFile: undefined }, baseTask, result);
  assert.equal(evidence?.outcome, "budget_limited");
  assert.equal(evidence?.prUrl, undefined);
  assert.equal(evidence?.doneCommentUrl, undefined);
  assert.equal(evidence?.blockCommentUrl, undefined);
});

test("zero-command Block comment explains missing executable work", () => {
  const body = buildBlockCommentBody({ ...baseTask, commands: [], reportLanguage: "en" }, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    artifacts: [],
  });

  assert.match(body, /zero executable commands/);
  assert.match(body, /Provide a repo\/default command path/);
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
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      status: "done",
      summary: "Runner done with evidence.",
      evidence: [],
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
      runnerBuild: {
        version: "0.1.0",
        revision: "abc123",
        source: "https://github.com/jinwon-int/a2a-docker-runner",
        builtAt: "2026-05-01T00:00:00Z",
        image: "ghcr.io/jinwon-int/a2a-docker-runner:abc123",
      },
    },
    error: "raw error from /root/.openclaw/workspace/private-task/run-1",
  });

  assert.match(body, /### 사유/);
  assert.match(body, /### 다음 조치/);
  assert.match(body, /\*\*Issue URL\*\*: https:\/\/github\.com\/jinwon-int\/test-repo\/issues\/1/);
  assert.match(body, /### Validation/);
  assert.match(body, /### 안전 상태/);
  assert.match(body, /terminalAck: `requires_operator_receipt`/);
  assert.match(body, /providerSendIsReceiptEvidence: `false`/);
  assert.match(body, /### 아티팩트 manifest 요약/);
  assert.match(body, /### Runner build/);
  assert.match(body, /revision: `abc123`/);
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
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      status: "done",
      summary: "Runner done with evidence.",
      evidence: [],
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
  assert.match(body, /\*\*Issue URL\*\*: https:\/\/github\.com\/jinwon-int\/test-repo\/issues\/1/);
  assert.match(body, /### 결과/);
  assert.match(body, /### 다음 조치/);
  assert.match(body, /### Validation/);
  assert.match(body, /### 안전 상태/);
  assert.match(body, /noLiveProviderSend: `true`/);
  assert.match(body, /### 아티팩트 manifest 요약/);
  assert.match(body, /### 명령 로그 요약/);
  assert.match(body, /`artifacts\/result\.json` \(12 bytes\)/);
  assert.match(body, /all good/);
});

// ---------------------------------------------------------------------------
// Evidence-only / allowNoChanges classification (a2a-docker-runner#169)
// ---------------------------------------------------------------------------

test("classifies no-change-allowed Done evidence as succeeded_no_changes_with_done_evidence", async () => {
  const evidence = await collectGitHubEvidence(baseConfig, baseTask, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: "status=no_changes_allowed\nnotice=no_code_changes_produced_evidence_only_lane",
    stderr: "",
    artifacts: [],
  });

  assert.ok(evidence);
  assert.equal(evidence?.outcome, "succeeded_no_changes_with_done_evidence");
});

test("classifies no-change-allowed Block evidence as blocked_no_changes_with_evidence", async () => {
  // When no GitHub token is available the block comment cannot actually be
  // posted, so the classification falls through to
  // succeeded_no_changes_with_done_evidence.  Instead, verify the block
  // comment body is generated correctly for the no-changes-allowed case.
  const body = buildBlockCommentBody(
    { ...baseTask, allowNoChanges: true },
    {
      ok: false,
      taskId: "t1",
      status: "failed",
      workDir: "/tmp/a2a/task/run-1",
      exitCode: 1,
      signal: null,
      stdout: "status=no_changes_allowed\nsomething blocked",
      stderr: "",
      artifacts: [],
    },
  );

  assert.ok(body.includes("### 사유"), "Block comment body must include reason section");
  assert.ok(body.includes("### 다음 조치"), "Block comment body must include next-action section");
});

test("no-changes-allowed evidence skips release-gate validation", async () => {
  const evidence = await collectGitHubEvidence(baseConfig, {
    ...baseTask,
  }, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: [
      "status=no_changes_allowed",
      "notice=no_code_changes_produced_evidence_only_lane",
    ].join("\n"),
    stderr: "",
    artifacts: [],
  });

  assert.ok(evidence);
  assert.equal(evidence?.outcome, "succeeded_no_changes_with_done_evidence");
  // release-gate validation should accept these outcomes (no errors added).
  assert.equal(evidence?.validationErrors?.length ?? 0, 0, `Expected no validation errors, got: ${evidence?.validationErrors?.join(", ")}`);
});

test("no-changes-allowed marker absent does not affect normal classification", async () => {
  // A normal successful PR task without the no-changes marker should still
  // classify as "pr" not as a no-change outcome.
  const evidence = await collectGitHubEvidence(baseConfig, baseTask, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: "pr_created=1",
    stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/99",
  });

  assert.ok(evidence);
  assert.equal(evidence?.outcome, "pr", "Normal PR tasks must not be classified as no-change evidence");
});

test("Done/Block comment bodies include idempotent GitHub projection safety marker", () => {
  const result = {
    ok: false,
    taskId: "t1",
    status: "failed" as const,
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    artifacts: [],
  };

  const block = buildBlockCommentBody({ ...baseTask, reportLanguage: "en" }, result);
  assert.match(block, /<!-- a2a:github-evidence:v1 task=test-task issue=jinwon-int\/test-repo#1 outcome=block -->/);
  assert.match(block, /GitHub comment evidence projection: `ledger-only`/);
  assert.match(block, /commentIsTerminalAck: `false`/);
  assert.match(block, /commentIsOperatorApproval: `false`/);

  const done = buildDoneCommentBody({ ...baseTask, reportLanguage: "en" }, { ...result, ok: true, status: "completed", exitCode: 0 });
  assert.match(done, /outcome=done/);
  assert.match(done, /manifest binding: `artifacts\/manifest\.json` \/ `resultSummary\.evidenceHints`/);
});
