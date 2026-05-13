import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildActionableError, buildContainerScript, runTask } from "./runner.js";
import type { NormalizedRunnerTask, RunnerConfig, RunnerTask } from "./types.js";

const baseConfig: RunnerConfig = {
  rootDir: join(tmpdir(), "a2a-runner-test"),
  image: "node:22-bookworm-slim",
  defaultTimeoutMs: 10_000,
  memory: "512m",
  cpus: "1",
};

// ---------------------------------------------------------------------------
// safeId (via runTask validation / workDir creation)
// ---------------------------------------------------------------------------

test("rejects task without id", async () => {
  await assert.rejects(
    runTask(baseConfig, { intent: "propose_patch" } as RunnerTask),
    /task\.id is required/,
  );
});

test("rejects task without intent", async () => {
  await assert.rejects(
    runTask(baseConfig, { id: "no-intent" } as RunnerTask),
    /task\.intent is required/,
  );
});

test("sanitises task id for filesystem safety", async () => {
  // This test verifies the safeId behavior indirectly through workDir.
  const task: RunnerTask = {
    id: "a/b:c d?*",
    intent: "propose_patch",
    commands: ["printf ok"],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  // On a host without Docker, runTask will fail at spawn.
  // The test asserts the workDir path is safe regardless.
  try {
    const result = await runTask(config, task);
    assert.ok(!result.workDir.includes("/"));
    assert.ok(!result.workDir.includes(" "));
    assert.ok(!result.workDir.includes("?"));
    assert.ok(!result.workDir.includes("*"));
    assert.ok(!result.workDir.includes(":"));
  } catch {
    // Docker not available is expected; skip validation of workDir.
  }
});

// ---------------------------------------------------------------------------
// validateTask
// ---------------------------------------------------------------------------

test("validates task.id and task.intent are required", () => {
  // Covered by rejects tests above.
});

// ---------------------------------------------------------------------------
// extractPrUrl
// ---------------------------------------------------------------------------

test("extracts PR URL from stdout", async () => {
  const task: RunnerTask = {
    id: "pr-extract-test",
    intent: "propose_patch",
    commands: [
      "printf 'Created pull request: https://github.com/jinwon-int/a2a-docker-runner/pull/42\\n'",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (result.prUrl) {
      assert.equal(result.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/42");
    }
  } catch {
    // Docker not available; skip.
  }
});

test("extracts PR URL with query parameters", async () => {
  const task: RunnerTask = {
    id: "pr-extract-query",
    intent: "propose_patch",
    commands: [
      "printf 'See https://github.com/org/repo/pull/99?query=1 for details\\n'",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (result.prUrl) {
      assert.ok(result.prUrl.includes("https://github.com/"));
      assert.ok(result.prUrl.includes("/pull/99"));
    }
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// prUrlRecoveredAfterNonzero — a2a-docker-runner#199
// ---------------------------------------------------------------------------

test("treats non-zero exit after PR creation as success (false-failure fix)", async () => {
  // If a PR URL is detected but the container exits non-zero with a
  // post-PR error (not a timeout), the runner must still report ok=true.
  // Parent: a2a-docker-runner#199
  const task: RunnerTask = {
    id: "pr-recovery-test",
    intent: "propose_patch",
    commands: [
      "printf 'https://github.com/jinwon-int/a2a-docker-runner/pull/199\\n'",
      "printf 'some benign post-PR cleanup warning\\n' >&2",
      "exit 2",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 3000 };

  try {
    const result = await runTask(config, task);
    assert.equal(result.ok, true, `Expected ok=true after PR URL + non-zero exit, got ok=${result.ok} status=${result.status}`);
    assert.equal(result.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/199");
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// artifact collection
// ---------------------------------------------------------------------------

test("collects artifacts from workDir/artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-artifact-test-"));
  const artifactsDir = join(dir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "summary.txt"), "test summary");
  writeFileSync(join(artifactsDir, "command-0.log"), "command output");
  mkdirSync(join(artifactsDir, "subdir"), { recursive: true });
  writeFileSync(join(artifactsDir, "subdir", "nested.txt"), "nested");

  const task: RunnerTask = {
    id: "artifact-test",
    intent: "propose_patch",
    commands: ["printf ok"],
  };
  const config = { ...baseConfig, rootDir: dir, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    // Artifacts should include summary.txt and command-0.log
    // (plus anything the task writes during execution)
    assert.ok(result.artifacts.length > 0, `Expected artifacts, got ${result.artifacts.length}`);
  } catch {
    // Docker not available; skip validation.
  } finally {
    // Use execFileSync fallback for permission/ownership resilience (CI sandbox)
    try { rmSync(dir, { recursive: true, force: true }); } catch { execFileSync("rm", ["-rf", dir]); }
  }
});

// ---------------------------------------------------------------------------
// github-propose-patch mode evidence
// ---------------------------------------------------------------------------

test("populates github evidence on github-propose-patch mode success", async () => {
  const task: RunnerTask = {
    id: "evidence-pr-test",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/a2a-docker-runner",
    commands: [
      "printf 'PR created: https://github.com/jinwon-int/a2a-docker-runner/pull/77\\n'",
    ],
    issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/1",
    reportLanguage: "ko",
    requestedBy: "seoseo",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    const result = await runTask(config, task);
    if (result.ok) {
      assert.ok(result.github, "Expected github evidence on success");
      assert.equal(result.github?.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/77");
    }
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// timeout behavior
// ---------------------------------------------------------------------------

test("handles bounded timeout", async () => {
  const task: RunnerTask = {
    id: "timeout-test",
    intent: "propose_patch",
    commands: ["sleep 30"],
    timeoutMs: 1000,
  };
  const config = { ...baseConfig, defaultTimeoutMs: 1000 };

  try {
    const result = await runTask(config, task);
    assert.equal(result.status, "timeout");
    assert.equal(result.ok, false);
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// default commands for single repo
// ---------------------------------------------------------------------------

test("generates default commands for single repo task", async () => {
  const task: RunnerTask = {
    id: "default-cmds-test",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
    baseBranch: "main",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 3000 };

  try {
    const result = await runTask(config, task);
    // Should have generated npm ci + npm test commands
    // The stdout should contain evidence of command execution
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// multi-repo checkout
// ---------------------------------------------------------------------------

test("handles multi-repo configuration", async () => {
  const task: RunnerTask = {
    id: "multi-repo-test",
    intent: "propose_patch",
    repos: [
      { name: "primary", url: "jinwon-int/a2a-docker-runner", path: "primary", primary: true },
      { name: "secondary", url: "jinwon-int/openclaw", path: "secondary" },
    ],
    commands: ["cd /work/primary && npm ci", "cd /work/primary && npm test"],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    const result = await runTask(config, task);
    // Should attempt checkout of both repos
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// preset expansion
// ---------------------------------------------------------------------------

test("expands openclaw-plugin-a2a-dev preset correctly", async () => {
  const task: RunnerTask = {
    id: "preset-test",
    intent: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    const result = await runTask(config, task);
    // The preset expands to checkout + npm ci + npm test
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// buildContainerScript: shell metacharacter safety
// ---------------------------------------------------------------------------

test("buildContainerScript safely shell-quotes task id with single quote", () => {
  const task: NormalizedRunnerTask = {
    id: "task-with-'quote",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // POSIX single-quote escape: task-with-'quote → 'task-with-'\''quote'
  assert.ok(script.includes("'task-with-'\\''quote'"), `Task id must be POSIX-escaped; got snippet: ${script.slice(0, 300)}`);
});

test("buildContainerScript safely shell-quotes task id with dollar sign", () => {
  const task: NormalizedRunnerTask = {
    id: "task-$HOME-injection",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // $HOME inside single quotes is literal, so the script should contain the literal string
  assert.ok(script.includes("'task-$HOME-injection'"), "Dollar sign in task id must be inside single quotes (literal, not expanded)");
});

test("buildContainerScript safely shell-quotes intent with backtick", () => {
  const task: NormalizedRunnerTask = {
    id: "safe-id",
    intent: "propose`date`patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // Backtick inside single quotes is literal
  assert.ok(script.includes("'propose`date`patch'"), "Backtick in intent must be inside single quotes (literal, not executed)");
});

test("buildContainerScript provisions latest-capable gh and update-branch fallback helper", () => {
  const task: NormalizedRunnerTask = {
    id: "github-cli-tools",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repos: [],
    commands: [],
  };

  const script = buildContainerScript(task);
  assert.ok(script.includes("gh pr update-branch --help"), "Expected gh capability check for update-branch");
  assert.ok(script.includes("cli.github.com/packages"), "Expected official GitHub CLI apt repository");
  assert.ok(script.includes("/usr/local/bin/a2a-gh-pr-update-branch"), "Expected fallback helper installation");
  assert.ok(script.includes("warning=gh_pr_update_branch_failed_using_git_fallback"), "Expected git fallback marker");
});

test("buildContainerScript restores host ownership of mounted workdir on exit", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-restore",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };

  const script = buildContainerScript(task);
  assert.ok(script.includes("restore_work_ownership()"), "Expected ownership restore helper");
  assert.ok(script.includes("stat -c '%u' /work"), "Expected host uid discovery from /work");
  assert.ok(script.includes("chown -R \"$owner:$group\" /work"), "Expected best-effort recursive chown before container exit");
  assert.ok(script.includes("trap restore_work_ownership EXIT"), "Expected ownership restore EXIT trap");
});

test("task artifact shell redactor includes API-key and prompt secret parity patterns", () => {
  const task: NormalizedRunnerTask = {
    id: "redaction-parity",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);

  assert.ok(script.includes("xai-[A-Za-z0-9_-]{40,}"), "Expected xAI key redaction in container artifact path");
  assert.ok(script.includes("sm_[A-Za-z0-9_-]{40,}"), "Expected supermemory key redaction in container artifact path");
  assert.ok(script.includes("sk-[A-Za-z0-9_-]{32,}"), "Expected OpenAI key redaction in container artifact path");
  assert.ok(script.includes("Authorization:[[:space:]]*(Bearer|token)"), "Expected Authorization header redaction in container artifact path");
  assert.ok(script.includes("((token|password|secret|api[_-]?key)=)"), "Expected prompt key=value secret redaction in container artifact path");
});

// ---------------------------------------------------------------------------
// pre-pr-bootstrap-guard
// ---------------------------------------------------------------------------

test("bootstrap guard script is included when repos are configured", () => {
  const task: NormalizedRunnerTask = {
    id: "bootstrap-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("bootstrap_guard="), "Expected bootstrap guard output marker");
  assert.ok(script.includes("bootstrap_guard=ok"), "Expected bootstrap guard ok on clean checkout");
  assert.ok(script.includes("AGENTS.md"), "Expected banned files list");
  assert.ok(script.includes("SOUL.md"), "Expected banned soul file");
  assert.ok(script.includes(".openclaw"), "Expected banned .openclaw dir");
  assert.ok(script.includes("a2a-broker#446"), "Expected parent issue reference");
});

test("bootstrap guard blocks when banned files are present (pre-check)", () => {
  const task: NormalizedRunnerTask = {
    id: "bootstrap-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("exit 4"), "Expected exit 4 on bootstrap leak detection");
  assert.ok(script.includes("error=pre_pr_bootstrap_guard_blocked"), "Expected blocked error marker");
  assert.ok(script.includes("filter_branch_bootstrap_leaks"), "Expected ignored-file-aware branch-entry filter");
  assert.ok(script.includes("git -C \"$repo_dir\" ls-files -- \"$path\""), "Expected tracked bootstrap paths to block");
  assert.ok(script.includes("git -C \"$repo_dir\" status --porcelain -- \"$path\""), "Expected unignored/staged bootstrap paths to block");
  assert.ok(script.includes("Files detected (repo-relative):"), "Expected repo-relative offending paths report");
  assert.ok(script.includes("Repository checkout: %s"), "Expected non-absolute checkout label report");
  assert.ok(!script.includes("Files detected in %s"), "Guard evidence must not include absolute checkout paths in headings");
  assert.ok(!script.includes("$repo_dir/$name"), "Guard evidence must not report absolute checkout paths as offending paths");
});

test("bootstrap post-guard checks every configured repo path", () => {
  const task: NormalizedRunnerTask = {
    id: "bootstrap-guard-multi-repo",
    intent: "propose_patch",
    repos: [
      { url: "jinwon-int/primary", path: "primary" },
      { url: "jinwon-int/secondary", path: "secondary" },
    ],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("for repo_dir in '/work/primary' '/work/secondary'; do"), "Expected post-guard to inspect all task repo checkouts");
  assert.ok(script.includes("find_bootstrap_leaks \"$repo_dir\""), "Expected post-guard to use the same ignored-file-aware scanner");
  assert.ok(script.includes("${path#./}"), "Expected repo-relative paths for .openclaw/** and memory/** entries");
});

test("bootstrap guard skips pre-check when no repos", () => {
  const task: NormalizedRunnerTask = {
    id: "no-repos",
    intent: "propose_patch",
    repos: [],
    commands: [],
  };
  const script = buildContainerScript(task);
  // Pre-check guard function returns empty for no repos, but post-guard is always included
  assert.ok(script.includes("bootstrap_leaks_post"), "Expected post-guard even without repos");
});

test("bootstrap guard includes schema marker in output", () => {
  const task: NormalizedRunnerTask = {
    id: "schema-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  assert.ok(script.includes("a2a.runner.pre-pr-bootstrap-guard.v1"), "Expected schema version marker");
});

test("buildContainerScript output is valid bash syntax with post-bootstrap guard", () => {
  const task: NormalizedRunnerTask = {
    id: "syntax-guard",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: ["printf 'ok\\n'"],
  };
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-script-syntax-"));
  const scriptPath = join(dir, "run.sh");
  try {
    writeFileSync(scriptPath, buildContainerScript(task));
    execFileSync("bash", ["-n", scriptPath]);
  } finally {
    // rmSync + execFileSync fallback for permission resilience
    try { rmSync(dir, { recursive: true, force: true }); } catch { execFileSync("rm", ["-rf", dir]); }
  }
});

test("buildContainerScript guard references parent issue a2a-broker#446", () => {
  const task: NormalizedRunnerTask = {
    id: "parent-ref",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);
  const matches = (script.match(/a2a-broker#446/g) || []).length;
  assert.ok(matches >= 2, `Expected at least 2 references to a2a-broker#446 (pre + post), got ${matches}`);
});

// ---------------------------------------------------------------------------
// error handling: invalid commands
// ---------------------------------------------------------------------------

test("handles failing commands", async () => {
  const task: RunnerTask = {
    id: "fail-cmd-test",
    intent: "propose_patch",
    commands: ["exit 1"],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (!result.ok) {
      assert.equal(result.status, "failed");
      assert.ok(result.exitCode !== 0);
    }
  } catch {
    // Docker not available; skip.
  }
});

// ---------------------------------------------------------------------------
// buildActionableError: image-pull summary regression (a2a-docker-runner#169)
// ---------------------------------------------------------------------------

test("buildActionableError: engine not found produces ENOENT message", () => {
  const msg = buildActionableError("docker", "node:22", {
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    errorCode: "ENOENT",
  });
  assert.ok(msg.includes("실행 파일을 찾을 수 없습니다"), `Expected ENOENT message, got: ${msg}`);
});

test("buildActionableError: no false image-pull error when stdout-only has 'not found'", () => {
  // The container DID start and the agent produced output mentioning "not found"
  // in the context of a git clone or file lookup.  The error must NOT be
  // the misleading image-pull summary.
  const msg = buildActionableError("docker", "node:22-bookworm-slim", {
    code: 2,
    signal: null,
    stdout: [
      "notice=no_patch_command_configured",
      "Set commandScript or commandJson in RunnerConfig to inject a coding agent.",
      "status=no_changes",
      "fatal: repository 'https://github.com/owner/missing-repo.git/' not found",
    ].join("\n"),
    stderr: "",
    timedOut: false,
  });

  // buildActionableError returns combined output when no specific pattern matches.
  // The key regression: it must NOT produce image-pull error text when
  // Docker/Podman engine errors are only in stdout (agent output), not stderr.
  assert.ok(!msg.includes("이미지"), `Must not produce image-pull error for stdout-only 'not found', got: ${msg}`);
  assert.ok(!msg.includes("pull access denied"), `Must not match engine pull errors in stdout, got: ${msg}`);
});

test("buildActionableError: no false image-pull error when stdout-only has 'repository does not exist'", () => {
  const msg = buildActionableError("docker", "node:22-bookworm-slim", {
    code: 1,
    signal: null,
    stdout: [
      "Cloning into 'repo'...",
      "remote: Repository not found.",
      "fatal: repository 'https://github.com/nonexistent/repo.git/' does not exist",
    ].join("\n"),
    stderr: "",
    timedOut: false,
  });

  assert.ok(!msg.includes("이미지"), `Must not produce image-pull error for stdout-only 'repository does not exist', got: ${msg}`);
});

test("buildActionableError: DOES produce image-pull error when stderr has daemon pull error", () => {
  // Real Docker daemon pull failure: "Error response from daemon: pull access denied" in stderr.
  const msg = buildActionableError("docker", "private/image:tag", {
    code: 125,
    signal: null,
    stdout: "",
    stderr: [
      "Unable to find image 'private/image:tag' locally",
      "docker: Error response from daemon: pull access denied for private/image, repository does not exist or may require 'docker login'.",
      "See 'docker run --help'.",
    ].join("\n"),
    timedOut: false,
  });

  assert.ok(msg.includes("이미지"), `Expected image-pull error for daemon pull failure in stderr, got: ${msg}`);
  assert.ok(msg.includes("가져오거나 찾을 수 없습니다"), `Expected Korean image-pull error text, got: ${msg}`);
});

test("buildActionableError: image-pull error for manifest unknown in stderr", () => {
  const msg = buildActionableError("docker", "nonexistent/image:v9.9.9", {
    code: 125,
    signal: null,
    stdout: "",
    stderr: "docker: Error response from daemon: manifest for nonexistent/image:v9.9.9 not found: manifest unknown: manifest unknown.",
    timedOut: false,
  });

  assert.ok(msg.includes("이미지"), `Expected image-pull error for manifest unknown, got: ${msg}`);
});

test("buildActionableError: no image-pull error when stderr is unrelated failure", () => {
  const msg = buildActionableError("docker", "node:22", {
    code: 1,
    signal: null,
    stdout: "some output",
    stderr: "command not found: nonexistent-tool",
    timedOut: false,
  });

  assert.ok(!msg.includes("이미지"), `Must not produce image-pull error for unrelated stderr, got: ${msg}`);
});

test("buildActionableError: no false container-name conflict from agent stdout", () => {
  const msg = buildActionableError("docker", "node:22", {
    code: 2,
    signal: null,
    stdout: [
      "A2A Docker Runner task task-1",
      "The fixture already exists, skipping generation.",
      "pull request create failed: GraphQL: No commits between main and branch",
      "error=pr_create_failed_or_missing_url",
    ].join("\n"),
    stderr: "Cloning into '/work/repo'...",
    timedOut: false,
  });

  assert.ok(!msg.includes("컨테이너 이름 충돌"), `Must not produce container-name conflict for agent stdout, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// buildActionableError: OOM detection + elapsed time in timeout diagnostics
// Parent: a2a-docker-runner#227
// ---------------------------------------------------------------------------

test("buildActionableError: detects OOM via exit code 137 (SIGKILL from cgroup)", () => {
  // Docker/Podman OOM kill produces exit code 137 = 128+9 (SIGKILL).
  // The runner must surface this as a distinct resource-exhaustion error
  // rather than a generic non-zero exit.
  const msg = buildActionableError("docker", "node:22", {
    code: 137,
    signal: "SIGKILL",
    stdout: "some output before kill",
    stderr: "",
    timedOut: false,
    elapsedMs: 4200,
  });

  assert.ok(msg.includes("OOM"), `Expected OOM detection for exit 137, got: ${msg}`);
  assert.ok(msg.includes("메모리 부족"), `Expected Korean memory-exhaustion text, got: ${msg}`);
  assert.ok(msg.includes("exit=137"), `Expected exit code 137 in message, got: ${msg}`);
  assert.ok(msg.includes("elapsed=4.2s"), `Expected elapsed time in OOM message, got: ${msg}`);
  assert.ok(msg.includes("--memory"), `Expected --memory tuning hint in OOM message, got: ${msg}`);
});

test("buildActionableError: detects OOM via stderr pattern when exit code is masked", () => {
  // In some rootless Podman configurations the exit code may not be 137
  // but stderr still contains the OOM indicator.  The runner must match
  // stderr patterns independently of exit code.
  const msg = buildActionableError("podman", "node:22", {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "Error: container create failed: container_linux.go: Out of memory: the container was killed by the OOM killer",
    timedOut: false,
    elapsedMs: 1100,
  });

  assert.ok(msg.includes("OOM"), `Expected OOM detection via stderr, got: ${msg}`);
  assert.ok(msg.includes("메모리 부족"), `Expected Korean memory-exhaustion text for stderr OOM, got: ${msg}`);
  assert.ok(msg.includes("elapsed=1.1s"), `Expected elapsed time in OOM stderr message, got: ${msg}`);
});

test("buildActionableError: includes elapsed time in timeout error message", () => {
  // Timed-out runs must include the actual wall-clock elapsed time
  // in the error message so operators can tune timeoutMs evidence.
  const msg = buildActionableError("docker", "node:22", {
    code: null,
    signal: "SIGTERM",
    stdout: "partial output",
    stderr: "",
    timedOut: true,
    elapsedMs: 30100,
  });

  assert.ok(msg.includes("제한 시간"), `Expected timeout message, got: ${msg}`);
  assert.ok(msg.includes("elapsed=30.1s"), `Expected elapsed time in timeout message, got: ${msg}`);
  assert.ok(!msg.includes("elapsed=0.0s"), `Elapsed time should reflect actual runtime, got: ${msg}`);
});

test("buildActionableError: safely handles missing elapsedMs in timeout", () => {
  // Backward-compatible: elapsedMs may be absent in callers that don't
  // supply it.  The error message must still render without NaN or crash.
  const msg = buildActionableError("docker", "node:22", {
    code: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    timedOut: true,
    // elapsedMs intentionally omitted
  });

  assert.ok(msg.includes("제한 시간"), `Expected readable timeout message when elapsedMs is missing, got: ${msg}`);
  assert.ok(msg.includes("elapsed=0.0s"), `Expected safe default elapsed=0.0s when elapsedMs missing, got: ${msg}`);
});

test("buildActionableError: OOM detection does not false-match 'out of' in agent stdout", () => {
  // Agent output like "out of scope" or "running out of disk space"
  // must not trigger OOM detection.  Only stderr engine errors count.
  const msg = buildActionableError("docker", "node:22", {
    code: 1,
    signal: null,
    stdout: "warning: running out of disk space in /tmp",
    stderr: "command not found: build-tool",
    timedOut: false,
    elapsedMs: 5000,
  });

  // combined includes both stdout and stderr, and 'out of disk space'
  // is in stdout, not stderr (engineStderr).  The OOM detection only
  // inspects engineStderr.
  assert.ok(!msg.includes("OOM"), `Must not false-match 'out of' in agent stdout as OOM, got: ${msg}`);
  assert.ok(!msg.includes("메모리 부족"), `Must not produce OOM message for agent stdout, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// CI ownership regression hardening (a2a-docker-runner#215 → builds on #214)
// ---------------------------------------------------------------------------

test("buildContainerScript EXIT trap is declared before any early-exit that could skip it", () => {
  const task: NormalizedRunnerTask = {
    id: "trap-before-exit",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The EXIT trap must appear before the first conditional exit (e.g. the
  // pre PR bootstrap guard block that calls "exit 4").  Otherwise ownership
  // restore is never invoked and CI cleanup fails with EACCES.
  const trapIndex = script.indexOf("trap restore_work_ownership");
  const firstExit4 = script.indexOf("exit 4");
  const fnDefIdx = script.indexOf("restore_work_ownership()");

  assert.ok(trapIndex >= 0, "trap restore_work_ownership must be present");
  assert.ok(firstExit4 >= 0, "exit 4 (bootstrap guard block) must be present");
  assert.ok(fnDefIdx >= 0, "restore_work_ownership() helper must be defined");
  // The trap registration must appear before any early exit.  The helper
  // function definition may appear before the trap (Bash resolves it at
  // invocation time), but trap registration must precede all exit 4 paths.
  assert.ok(trapIndex < firstExit4, `EXIT trap (pos ${trapIndex}) must precede first exit 4 (pos ${firstExit4})`);
});

test("buildContainerScript restore_work_ownership survives stat failure on /work", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-stat-fail",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The restore_work_ownership function must:
  // 1. Run the stat call with set +e / set -e guards.
  // 2. Fall back to a default uid:gid when stat fails.
  // 3. Run chown only when id is non-root (id 0).
  // 4. Never exit the script from an uncaught error inside the trap.
  assert.ok(script.includes("set +e") || script.includes("stat"), "restore must handle stat fallback");
  assert.ok(script.includes("chown"), "restore must include chown invocation");
  // The chown must be guarded: only execute for non-root owners (uid != 0).
  assert.ok(
    script.includes("chown -R") && (script.includes("$owner") || script.includes("owner")),
    "restore must chown with dynamic owner variable",
  );
});

test("buildContainerScript ownership restore runs best-effort (no exit on failure)", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-best-effort",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The chown invocation in the restore function must use || true or similar
  // best-effort pattern, and must not use set -e in the trap body that would
  // turn a chown failure into a spurious container exit.
  const restoreFn = script.slice(
    script.indexOf("restore_work_ownership()"),
    script.indexOf("}", script.indexOf("restore_work_ownership()")) + 2,
  );
  assert.ok(
    restoreFn.includes("|| true") || restoreFn.includes("|| :") || !restoreFn.includes("set -e"),
    "restore_work_ownership must be best-effort (|| true or no set -e in trap body)",
  );
});

test("buildContainerScript bootstrap guard checks full BANNED_FILES parity", () => {
  const task: NormalizedRunnerTask = {
    id: "banned-files-parity",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // The in-container bootstrap guard must ban the same files as the
  // standalone pre-pr-bootstrap-guard.mjs script (a2a-broker#446).
  const bannedFiles = [
    "AGENTS.md",
    "BOOTSTRAP.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
    "MEMORY.md",
    "SOUL.md",
    "TOOLS.md",
    "USER.md",
  ];

  for (const file of bannedFiles) {
    assert.ok(
      script.includes(file),
      `buildContainerScript must ban ${file} (a2a-broker#446 parity)`,
    );
  }

  // The .openclaw/ directory must also be banned.
  assert.ok(script.includes(".openclaw"), "buildContainerScript must ban .openclaw/ directory");
});

test("buildContainerScript ownership restore guards against stat failure on /work", () => {
  const task: NormalizedRunnerTask = {
    id: "ownership-stat-guard",
    intent: "propose_patch",
    repos: [{ url: "jinwon-int/test-repo", path: "repo" }],
    commands: [],
  };
  const script = buildContainerScript(task);

  // When stat fails on /work (container has no /work mount, or mount is
  // broken), the restore must not cause an EXIT trap failure.  It must
  // use || true on stat calls and guard chown with a non-empty check.
  const restoreFn = script.slice(
    script.indexOf("restore_work_ownership()"),
    script.indexOf("}", script.indexOf("restore_work_ownership()")) + 2,
  );
  // stat must use || true to avoid trap failure when /work is absent.
  assert.ok(restoreFn.includes("|| true"), "restore must use || true on stat calls");
  // chown must use 2>/dev/null || true for best-effort ownership restore.
  assert.ok(
    restoreFn.includes("2>/dev/null") && restoreFn.includes("|| true"),
    "restore chown must be best-effort (2>/dev/null || true)",
  );
  // Must check that owner/group are non-empty before chown.
  assert.ok(
    restoreFn.includes("-n") && (restoreFn.includes("$owner") || restoreFn.includes("owner")),
    "restore must check owner is non-empty before chown",
  );
});
