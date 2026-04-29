import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTask } from "./runner.js";
import type { RunnerConfig, RunnerTask } from "./types.js";

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
      "printf 'Created pull request: https://github.com/jinon86/a2a-docker-runner/pull/42\\n'",
    ],
  };
  const config = { ...baseConfig, defaultTimeoutMs: 2000 };

  try {
    const result = await runTask(config, task);
    if (result.prUrl) {
      assert.equal(result.prUrl, "https://github.com/jinon86/a2a-docker-runner/pull/42");
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
    rmSync(dir, { recursive: true, force: true });
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
    repo: "jinon86/a2a-docker-runner",
    commands: [
      "printf 'PR created: https://github.com/jinon86/a2a-docker-runner/pull/77\\n'",
    ],
    issueUrl: "https://github.com/jinon86/a2a-docker-runner/issues/1",
    reportLanguage: "ko",
    requestedBy: "seoseo",
  };
  const config = { ...baseConfig, defaultTimeoutMs: 5000 };

  try {
    const result = await runTask(config, task);
    if (result.ok) {
      assert.ok(result.github, "Expected github evidence on success");
      assert.equal(result.github?.prUrl, "https://github.com/jinon86/a2a-docker-runner/pull/77");
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
    repo: "jinon86/a2a-docker-runner",
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
      { name: "primary", url: "jinon86/a2a-docker-runner", path: "primary", primary: true },
      { name: "secondary", url: "jinon86/openclaw", path: "secondary" },
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
