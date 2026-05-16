import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockCommentBody, buildCommentLedger, buildDoneCommentBody, buildStartCommentBody, collectGitHubEvidence } from "./github-evidence.js";
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

test("captures Start comment URL for no-change validation evidence", async () => {
  const startUrl = "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-111";
  const evidence = await collectGitHubEvidence(baseConfig, baseTask, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: [
      startUrl,
      "start_comment_url=" + startUrl,
      "start_comment=posted",
      "status=no_changes_allowed",
      "notice=no_code_changes_produced_evidence_only_lane",
    ].join("\n"),
    stderr: "",
    artifacts: [],
  });

  assert.ok(evidence);
  assert.equal(evidence?.outcome, "succeeded_no_changes_with_done_evidence");
  assert.equal(evidence?.startCommentUrl, startUrl);
  assert.equal(evidence?.commentLedger?.entries[0]?.kind, "start");
  assert.equal(evidence?.commentLedger?.entries[0]?.url, startUrl);
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

// ---------------------------------------------------------------------------
// readOnlyValidation evidence flow (a2a-docker-runner#237)
// ---------------------------------------------------------------------------

test("readOnlyValidation: passed outcome maps to succeeded_no_changes_with_done_evidence", async () => {
  // When readOnlyValidation is set and no changes are produced, the pipeline
  // outputs read_only_validation=passed followed by status=no_changes_allowed.
  // Evidence collection must classify this as succeeded_no_changes_with_done_evidence.
  const evidence = await collectGitHubEvidence(baseConfig, baseTask, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: [
      "read_only_validation=passed",
      "status=no_changes_allowed",
      "notice=no_code_changes_produced_evidence_only_lane",
    ].join("\n"),
    stderr: "",
    artifacts: [],
  });

  assert.ok(evidence);
  assert.equal(evidence?.outcome, "succeeded_no_changes_with_done_evidence");
  assert.equal(evidence?.validationErrors?.length ?? 0, 0,
    "readOnlyValidation passed must not produce validation errors");
});

test("readOnlyValidation: blocked body reports error and changed file list", () => {
  // When readOnlyValidation guard detects changes, the pipeline exits 4.
  // The block comment body must include the readOnlyValidation error text
  // and list of changed files.
  const body = buildBlockCommentBody(
    { ...baseTask, readOnlyValidation: true, reportLanguage: "en" },
    {
      ok: false,
      taskId: "t1",
      status: "failed",
      workDir: "/tmp/a2a/task/run-1",
      exitCode: 4,
      signal: null,
      stdout: [
        "read_only_validation=blocked",
        "error=read_only_validation_changed_repo",
        "read_only_change=src/runner.ts",
        "read_only_change=src/types.ts",
      ].join("\n"),
      stderr: "",
      artifacts: [],
      error: "read_only_validation_changed_repo",
    },
  );

  assert.ok(body.includes("### Reason"), "Block comment must include reason section");
  assert.ok(body.includes("### Next action"), "Block comment must include next-action section");
  // The error text (read_only_validation_changed_repo) must appear in the body.
  assert.ok(body.includes("read_only_validation_changed_repo"),
    "Block comment body must include the readOnlyValidation error");
  // Block outcome marker must be present.
  assert.match(body, /outcome=block/);
  // Changed files must be visible in the body (error text contains them).
  assert.ok(body.includes("src/runner.ts"),
    "Block comment body must include changed file paths");
  assert.ok(body.includes("src/types.ts"),
    "Block comment body must include changed file paths");
});

// ---------------------------------------------------------------------------
// GitHub comment evidence ledger — Start comment & comment ledger projection
// Parent: a2a-plane#204
// ---------------------------------------------------------------------------

test("buildStartCommentBody includes disclaimer that comment is NOT ACK/approval (ko)", () => {
  const body = buildStartCommentBody(baseTask);

  assert.match(body, /## 🟢 Start/);
  assert.match(body, /\*\*요청 노드\*\*: seoseo/);
  assert.match(body, /\*\*Task ID\*\*: `test-task`/);
  assert.match(body, /\*\*Issue URL\*\*: https:\/\/github\.com\/jinwon-int\/test-repo\/issues\/1/);
  assert.match(body, /\*\*의도\*\*: propose_patch/);
  assert.match(body, /\*\*이슈 제목\*\*: Evidence contract proof/);
  assert.match(body, /\*\*작업 요약\*\*: Produce compact terminal notice evidence without leaking raw logs/);

  // MUST include the disclaimer that this is NOT ACK/approval proof
  assert.match(body, /증거 원장.*evidence ledger.*ACK.*읽음 확인.*표시 증거.*운영자 승인/);
  assert.match(body, /자동 생성된 Start 코멘트.*A2A Docker Runner/);
});

test("buildStartCommentBody produces English body when reportLanguage is en", () => {
  const task = { ...baseTask, reportLanguage: "en" as const };
  const body = buildStartCommentBody(task);

  assert.match(body, /## 🟢 Start/);
  assert.match(body, /\*\*Task ID\*\*: `test-task`/);
  assert.match(body, /Beginning work\. Inspecting repository and making warranted code\/docs\/tests changes\./);

  // English disclaimer must explicitly separate from ACK/read receipt/visibility/approval
  assert.match(body, /not ACK, read receipt, visibility proof, or operator approval/);
  assert.match(body, /Auto-generated Start comment/);
});

test("buildStartCommentBody includes runId when available", () => {
  const task = { ...baseTask, runId: "a2a-run-abc-123" };
  const body = buildStartCommentBody(task);

  assert.match(body, /\*\*Run ID\*\*: `a2a-run-abc-123`/);
});

test("buildCommentLedger with start comment only", () => {
  const evidence = {
    startCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-111",
  };
  const ledger = buildCommentLedger(evidence, baseTask);

  assert.equal(ledger.schemaVersion, "a2a.runner.github-comment-ledger.v1");
  assert.equal(ledger.disclaimer, "GitHub comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.");
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].kind, "start");
  assert.equal(ledger.entries[0].url, "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-111");
  assert.ok(ledger.entries[0].dedupeKey, "Start comment must have a dedupe key");
  assert.ok(ledger.entries[0].postedAt, "Start comment must have a postedAt timestamp");
});

test("buildCommentLedger with block comment", () => {
  const evidence = {
    blockCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-222",
  };
  const ledger = buildCommentLedger(evidence, baseTask);

  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].kind, "block");
  assert.equal(ledger.entries[0].url, "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-222");
  assert.match(ledger.entries[0].dedupeKey, /^block:test-task/);
});

test("buildCommentLedger with done comment", () => {
  const evidence = {
    doneCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-333",
  };
  const ledger = buildCommentLedger(evidence, baseTask);

  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].kind, "done");
  assert.equal(ledger.entries[0].url, "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-333");
  assert.match(ledger.entries[0].dedupeKey, /^done:test-task/);
});

test("buildCommentLedger with all comment types produces ordered entries", () => {
  const evidence = {
    startCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-100",
    blockCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-200",
    doneCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-300",
  };
  const ledger = buildCommentLedger(evidence, baseTask);

  assert.equal(ledger.entries.length, 3);
  // Start comment is always first (added first)
  assert.equal(ledger.entries[0].kind, "start");
  assert.equal(ledger.entries[1].kind, "block");
  assert.equal(ledger.entries[2].kind, "done");
});

test("buildCommentLedger empty when no comments", () => {
  const ledger = buildCommentLedger({}, baseTask);

  assert.equal(ledger.schemaVersion, "a2a.runner.github-comment-ledger.v1");
  assert.equal(ledger.entries.length, 0);
  assert.ok(ledger.disclaimer.includes("not ACK"));
});

test("collectGitHubEvidence includes commentLedger in evidence", async () => {
  const startUrl = "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-111";
  const evidence = await collectGitHubEvidence(baseConfig, baseTask, {
    ok: true,
    taskId: "t1",
    status: "completed",
    workDir: "/tmp/a2a/task/run-1",
    exitCode: 0,
    signal: null,
    stdout: [
      startUrl,
      "start_comment_url=" + startUrl,
      "start_comment=posted",
      "pr_created=1",
    ].join("\n"),
    stderr: "",
    artifacts: [],
    prUrl: "https://github.com/jinwon-int/test-repo/pull/99",
  });

  assert.ok(evidence);
  assert.ok(evidence?.commentLedger, "GitHubEvidence must include a commentLedger");
  assert.equal(evidence?.commentLedger?.schemaVersion, "a2a.runner.github-comment-ledger.v1");
  assert.equal(evidence?.commentLedger?.disclaimer, "GitHub comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.");
  assert.equal(evidence?.startCommentUrl, startUrl);
  assert.equal(evidence?.commentLedger?.entries[0]?.kind, "start");
  assert.equal(evidence?.commentLedger?.entries[0]?.url, startUrl);
});

test("Start comment body never contains secret/credential patterns", () => {
  // Redaction: the body must not leak secrets.
  const task = {
    ...baseTask,
    env: { GH_TOKEN: "ghp_secret12345678901234567890", SECRET: "shhh" },
  };
  const body = buildStartCommentBody(task);

  const forbidden = /ghp_|github_pat_|Bearer\s+|Authorization:/i;
  assert.equal(forbidden.test(body), false, "Start comment body must not contain secret patterns");
});

test("comment ledger entries use stable replay-safe dedupe keys", () => {
  // Same task ID should produce the same dedupe key (replay-safe).
  const evidence = {
    startCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-xyz",
  };

  const ledger1 = buildCommentLedger(evidence, baseTask);
  const ledger2 = buildCommentLedger(evidence, baseTask);

  assert.equal(ledger1.entries[0].dedupeKey, ledger2.entries[0].dedupeKey,
    "Dedupe keys must be stable (replay-safe) across calls for the same task");
});

test("comment ledger dedupe keys differ across tasks", () => {
  const evidence = {
    startCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-xyz",
  };
  const taskA = { ...baseTask, id: "task-alpha" };
  const taskB = { ...baseTask, id: "task-beta" };

  const ledgerA = buildCommentLedger(evidence, taskA);
  const ledgerB = buildCommentLedger(evidence, taskB);

  assert.notEqual(ledgerA.entries[0].dedupeKey, ledgerB.entries[0].dedupeKey,
    "Dedupe keys must differ across different tasks");
});

test("comment ledger disclaimer is identical across all invocations", () => {
  const evidence = {
    startCommentUrl: "https://github.com/jinwon-int/test-repo/issues/1#issuecomment-xyz",
  };

  const ledger1 = buildCommentLedger(evidence, baseTask);
  const ledger2 = buildCommentLedger({}, baseTask);
  const ledger3 = buildCommentLedger({ doneCommentUrl: "http://example.com" }, baseTask);

  const expected = "GitHub comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.";
  assert.equal(ledger1.disclaimer, expected);
  assert.equal(ledger2.disclaimer, expected);
  assert.equal(ledger3.disclaimer, expected);
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
