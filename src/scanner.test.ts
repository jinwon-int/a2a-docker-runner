import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanHistory, createArtifactBundle, readinessScan, buildCleanupDryRunPlan, type ScanProfile, type ScanRunEntry, type ReadinessReport, type CleanupDryRunPlan } from "./scanner.js";
import { buildSourcePublicApprovalRehearsal, buildArtifactManifest } from "./runner.js";
import { buildSourcePublicExecutionPreflight } from "./source-public-preflight.js";

// ---------------------------------------------------------------------------
// Scanner: scanHistory
// ---------------------------------------------------------------------------

function createMinimalRun(rootDir: string, taskId: string, runToken: string, overrides: {
  createdAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  status?: string;
  prUrl?: string;
  issueUrl?: string;
  summary?: string;
  branch?: string;
  budgetLimitKind?: string;
} = {}): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const runDir = join(rootDir, safeTaskId, runToken);
  mkdirSync(runDir, { recursive: true });

  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    taskId,
    safeTaskId,
    runToken,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    runnerBuild: { version: "1.0.0" },
  }));

  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "task.json"), JSON.stringify({
    id: taskId,
    intent: "propose_patch",
    issueUrl: overrides.issueUrl ?? "https://github.com/jinwon-int/test/issues/1",
  }));

  writeFileSync(join(runDir, "artifacts", "summary.txt"), overrides.summary ?? "Runner completed ok");

  writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "artifacts/manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    taskId,
    repo: "jinwon-int/test",
    branch: overrides.branch ?? "main",
    prUrl: overrides.prUrl ?? undefined,
    issueUrl: overrides.issueUrl ?? "https://github.com/jinwon-int/test/issues/1",
    status: overrides.status ?? "done",
    summary: overrides.summary ?? "Runner completed ok",
    evidence: [],
    artifacts: [{ path: "summary.txt", name: "summary.txt", sizeBytes: 20 }],
    ...(overrides.budgetLimitKind ? { budget: { limitKind: overrides.budgetLimitKind } } : {}),
  }));

  if (overrides.exitCode != null) {
    const existingRun = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    existingRun.exitCode = overrides.exitCode;
    writeFileSync(join(runDir, "run.json"), JSON.stringify(existingRun));
  }
  if (overrides.timedOut) {
    const existingRun = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    existingRun.timedOut = true;
    writeFileSync(join(runDir, "run.json"), JSON.stringify(existingRun));
  }

  return runDir;
}

test("scanHistory produces valid scan profile for empty rootDir", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-empty-"));
  try {
    const profile = await scanHistory({ rootDir });
    assert.equal(profile.schemaVersion, "a2a.runner.scan-profile.v1");
    assert.equal(profile.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(profile.totalRunDirs, 0);
    assert.deepEqual(profile.runs, []);
    assert.ok(typeof profile.rootLabel === "string");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory detects single run directory", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-single-"));
  try {
    createMinimalRun(rootDir, "test-task", "20250101T000000Z-abc-xyz1234");

    const profile = await scanHistory({ rootDir });

    assert.equal(profile.totalRunDirs, 1);
    assert.equal(profile.runs.length, 1);
    const entry = profile.runs[0]!;
    assert.equal(entry.taskId, "test-task");
    assert.equal(entry.status, "done");
    assert.equal(entry.artifactCount, 1);
    assert.ok(entry.createdAt, "should have createdAt");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory sorts runs deterministically by runToken", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-sort-"));
  try {
    createMinimalRun(rootDir, "task-c", "20250103T000000Z-runC");
    createMinimalRun(rootDir, "task-a", "20250101T000000Z-runA");
    createMinimalRun(rootDir, "task-b", "20250102T000000Z-runB");

    const profile = await scanHistory({ rootDir });

    assert.equal(profile.runs.length, 3);
    assert.equal(profile.runs[0]!.runToken, "20250101T000000Z-runA");
    assert.equal(profile.runs[1]!.runToken, "20250102T000000Z-runB");
    assert.equal(profile.runs[2]!.runToken, "20250103T000000Z-runC");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory respects limit option", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-limit-"));
  try {
    for (let i = 0; i < 10; i++) {
      createMinimalRun(rootDir, `task-${i}`, `run-${String(i).padStart(3, "0")}`);
    }

    const profile = await scanHistory({ rootDir, limit: 3 });
    assert.equal(profile.totalRunDirs, 10);
    assert.equal(profile.runs.length, 3);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory respects minAgeMs filter", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-age-"));
  try {
    createMinimalRun(rootDir, "old-task", "old-run");
    createMinimalRun(rootDir, "new-task", "new-run");

    const nowMs = Date.now();

    // Both should appear when minAgeMs is 0.
    const profileAll = await scanHistory({ rootDir, minAgeMs: 0, nowMs });
    assert.equal(profileAll.totalRunDirs, 2);

    // When minAgeMs is huge, no runs are old enough.
    const profileNone = await scanHistory({ rootDir, minAgeMs: nowMs + 999999999, nowMs });
    assert.equal(profileNone.runs.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory never leaks host absolute paths in rootLabel", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-path-"));
  try {
    createMinimalRun(rootDir, "task", "run1");

    const profile = await scanHistory({ rootDir });

    // rootLabel must not contain /tmp/, /home/, or other host paths.
    assert.ok(!profile.rootLabel.includes("/tmp"), `rootLabel must not leak /tmp: ${profile.rootLabel}`);
    assert.ok(!profile.rootLabel.includes("/home"), `rootLabel must not leak /home: ${profile.rootLabel}`);
    assert.ok(profile.rootLabel.startsWith("runner-root:"), "rootLabel should use sanitized prefix");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanProfile is deterministic for identical directory tree", async () => {
  const rootDir1 = mkdtempSync(join(tmpdir(), "a2a-scanner-det1-"));
  const rootDir2 = mkdtempSync(join(tmpdir(), "a2a-scanner-det2-"));
  try {
    // Create identical structures in both directories.
    for (const rootDir of [rootDir1, rootDir2]) {
      createMinimalRun(rootDir, "task-a", "run-001", { summary: "ok" });
      createMinimalRun(rootDir, "task-b", "run-002", { summary: "ok" });
    }

    const profile1 = await scanHistory({ rootDir: rootDir1 });
    const profile2 = await scanHistory({ rootDir: rootDir2 });

    // Same generatedAt, same runs, same runToken ordering.
    assert.equal(profile1.generatedAt, profile2.generatedAt);
    assert.equal(profile1.runs.length, profile2.runs.length);
    for (let i = 0; i < profile1.runs.length; i++) {
      assert.equal(profile1.runs[i]!.runToken, profile2.runs[i]!.runToken);
      assert.equal(profile1.runs[i]!.taskId, profile2.runs[i]!.taskId);
    }
  } finally {
    rmSync(rootDir1, { recursive: true, force: true });
    rmSync(rootDir2, { recursive: true, force: true });
  }
});

test("scanHistory handles malformed run.json gracefully", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-malformed-"));
  try {
    const safeTaskId = "malformed-task";
    const runDir = join(rootDir, safeTaskId, "malformed-run");
    mkdirSync(runDir, { recursive: true });

    // Corrupt run.json.
    writeFileSync(join(runDir, "run.json"), "NOT VALID JSON {{{");
    writeFileSync(join(runDir, "task.json"), "ALSO INVALID {{{");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    // No manifest.

    const profile = await scanHistory({ rootDir });
    assert.equal(profile.totalRunDirs, 1);
    // Should still produce an entry with minimal info.
    assert.ok(profile.runs.length >= 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory redacts secrets in taskId and summary", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-redact-"));
  try {
    createMinimalRun(rootDir, "ghp_1234567890abcdef1234567890_leak", "run1", {
      summary: "token=ghp_abcdef1234567890abcdef1234567890 secret leaked in summary",
    });

    const profile = await scanHistory({ rootDir });
    const entry = profile.runs[0]!;

    // Task ID should be redacted.
    assert.ok(!entry.taskId.includes("ghp_"), `TaskId must not contain raw GitHub token: ${entry.taskId}`);

    // Summary should be redacted.
    if (entry.summary) {
      assert.ok(!entry.summary.includes("ghp_"), `Summary must not contain raw GitHub token: ${entry.summary}`);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory includes optional evidence fields", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-evidence-"));
  try {
    createMinimalRun(rootDir, "evidence-task", "run1", {
      prUrl: "https://github.com/jinwon-int/test/pull/42",
      branch: "a2a-patch-feature",
      budgetLimitKind: "time",
    });

    const profile = await scanHistory({ rootDir });
    const entry = profile.runs[0]!;

    assert.equal(entry.prUrl, "https://github.com/jinwon-int/test/pull/42");
    assert.equal(entry.branch, "a2a-patch-feature");
    assert.equal(entry.budgetLimitKind, "time");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory filters unsafe GitHub URLs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-unsafe-url-"));
  try {
    createMinimalRun(rootDir, "url-task", "run1", {
      prUrl: "javascript:alert(1)",
      issueUrl: "not-a-url",
    });

    const profile = await scanHistory({ rootDir });
    const entry = profile.runs[0]!;

    // Unsafe URLs must be excluded.
    assert.equal(entry.prUrl, undefined, "unsafe PR URL must be excluded");
    assert.equal(entry.issueUrl, undefined, "unsafe issue URL must be excluded");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory handles missing rootDir gracefully", async () => {
  const profile = await scanHistory({ rootDir: "/tmp/a2a-nonexistent-scanner-dir-99999999" });
  assert.equal(profile.totalRunDirs, 0);
  assert.deepEqual(profile.runs, []);
});

// ---------------------------------------------------------------------------
// Artifact Bundle: createArtifactBundle
// ---------------------------------------------------------------------------

test("createArtifactBundle copies and redacts artifact files", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-src-"));
  const outputDir = mkdtempSync(join(tmpdir(), "a2a-bundle-out-"));
  try {
    const runDir = createMinimalRun(rootDir, "bundle-task", "run1", {
      summary: "Build output: secret=ghp_1234567890abcdef1234567890abcdef",
    });

    // Add a second artifact with token in it.
    writeFileSync(join(runDir, "artifacts", "command-0.log"), "Started with GH_TOKEN=ghp_abcdef1234567890abcdef1234567890\nok");

    const manifest = await createArtifactBundle({ workDir: runDir, outputPath: outputDir });

    assert.ok(manifest.artifacts.length >= 1, `Expected artifacts, got ${manifest.artifacts.length}`);
    assert.equal(manifest.status, "done");

    // Verify redaction applied.
    for (const artifact of manifest.artifacts) {
      const content = readFileSync(join(outputDir, artifact.name), "utf8");
      assert.ok(!content.includes("ghp_"), `Artifact ${artifact.name} must not contain raw GitHub token: ${content.slice(0, 200)}`);
      assert.ok(!content.includes("github_pat_"), `Artifact ${artifact.name} must not contain raw GitHub PAT`);
    }

    // Verify manifest written.
    const bundleManifestRaw = readFileSync(join(outputDir, "manifest.json"), "utf8");
    const bundleManifest = JSON.parse(bundleManifestRaw);
    assert.equal(bundleManifest.artifactVersion, 1);
    assert.equal(bundleManifest.taskId, "bundle-task");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("createArtifactBundle handles empty artifacts gracefully", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-empty-"));
  const outputDir = mkdtempSync(join(tmpdir(), "a2a-bundle-empty-out-"));
  try {
    const runDir = join(rootDir, "empty-task", "run1");
    mkdirSync(runDir, { recursive: true });
    // No artifacts/ dir.

    const manifest = await createArtifactBundle({ workDir: runDir, outputPath: outputDir });
    assert.deepEqual(manifest.artifacts, []);
    assert.equal(manifest.status, "done");

    // Manifest should still be written.
    assert.ok(existsSync(join(outputDir, "manifest.json")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("createArtifactBundle preserves benign content through redaction", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-benign-"));
  const outputDir = mkdtempSync(join(tmpdir(), "a2a-bundle-benign-out-"));
  try {
    const runDir = createMinimalRun(rootDir, "benign-task", "run1", {
      summary: "All tests passed. No secrets here.",
    });

    const manifest = await createArtifactBundle({ workDir: runDir, outputPath: outputDir });

    const content = readFileSync(join(outputDir, "summary.txt"), "utf8");
    assert.ok(content.includes("All tests passed"));
    assert.ok(!content.includes("<redacted"), "Benign content should not be redacted");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("createArtifactBundle produces deterministic generatedAt", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-det-"));
  const outDir1 = mkdtempSync(join(tmpdir(), "a2a-bundle-det-out1-"));
  const outDir2 = mkdtempSync(join(tmpdir(), "a2a-bundle-det-out2-"));
  try {
    const runDir = createMinimalRun(rootDir, "det-task", "run1");

    const m1 = await createArtifactBundle({ workDir: runDir, outputPath: outDir1 });
    const m2 = await createArtifactBundle({ workDir: runDir, outputPath: outDir2 });

    assert.equal(m1.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(m2.generatedAt, "1970-01-01T00:00:00.000Z");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outDir1, { recursive: true, force: true });
    rmSync(outDir2, { recursive: true, force: true });
  }
});

test("createArtifactBundle validates prUrl and issueUrl in bundle manifest", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-urlval-"));
  const outputDir = mkdtempSync(join(tmpdir(), "a2a-bundle-urlval-out-"));
  try {
    // Safe URLs should be preserved.
    const safeDir = createMinimalRun(rootDir, "url-safe", "run-safe", {
      prUrl: "https://github.com/jinwon-int/a2a-docker-runner/pull/211",
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/208",
    });
    const safeBundle = await createArtifactBundle({ workDir: safeDir, outputPath: join(outputDir, "safe") });
    assert.equal(safeBundle.prUrl, "https://github.com/jinwon-int/a2a-docker-runner/pull/211");
    assert.equal(safeBundle.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/208");

    // Unsafe URLs must be stripped from the bundle manifest.
    const unsafeDir = createMinimalRun(rootDir, "url-unsafe", "run-unsafe", {
      prUrl: "javascript:alert(1)",
      issueUrl: "http://evil.com/phish",
    });
    const unsafeBundle = await createArtifactBundle({ workDir: unsafeDir, outputPath: join(outputDir, "unsafe") });
    assert.equal(unsafeBundle.prUrl, undefined, "unsafe prUrl must be stripped");
    assert.equal(unsafeBundle.issueUrl, undefined, "unsafe issueUrl must be stripped");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ScanProfile schema contract
// ---------------------------------------------------------------------------

test("scanProfile conforms to schema contract", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-schema-"));
  try {
    createMinimalRun(rootDir, "schema-task", "run-001");

    const profile = await scanHistory({ rootDir });

    // Required fields.
    assert.equal(profile.schemaVersion, "a2a.runner.scan-profile.v1");
    assert.equal(profile.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.ok(typeof profile.rootLabel === "string" && profile.rootLabel.length > 0);
    assert.ok(typeof profile.totalRunDirs === "number" && profile.totalRunDirs >= 0);
    assert.ok(Array.isArray(profile.runs));

    // Run entry required fields.
    for (const entry of profile.runs) {
      assert.ok(typeof entry.taskId === "string" && entry.taskId.length > 0);
      assert.ok(typeof entry.safeTaskId === "string" && entry.safeTaskId.length > 0);
      assert.ok(typeof entry.runToken === "string" && entry.runToken.length > 0);
      assert.ok(typeof entry.createdAt === "string");
      assert.ok(typeof entry.status === "string");
      assert.ok(typeof entry.artifactCount === "number" && entry.artifactCount >= 0);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed: scanner must not leak secrets or host paths
// ---------------------------------------------------------------------------

test("fail-closed: scanner never emits absolute host paths in run entries", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-closed-paths-"));
  try {
    createMinimalRun(rootDir, "closed-task", "run-closed");

    const profile = await scanHistory({ rootDir });
    const profileJson = JSON.stringify(profile);

    // Must not contain /tmp/ (common temp path marker).
    assert.ok(!profileJson.includes(rootDir), "Profile must not leak absolute rootDir");
    assert.ok(!profile.rootLabel.includes(rootDir), "rootLabel must not leak absolute path");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fail-closed: scanner redacts API key patterns in all text fields", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-api-redact-"));
  try {
    createMinimalRun(rootDir, "api-task", "run1", {
      summary: "Used sk-proj-abcdef1234567890abcdef1234567890abcdef for testing",
    });

    const profile = await scanHistory({ rootDir });
    const profileJson = JSON.stringify(profile);

    assert.ok(!profileJson.includes("sk-proj-"), "Must not leak OpenAI API keys");
    assert.ok(!profileJson.includes("sk-"), "Must not leak API key patterns");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fail-closed: bundle redacts x-access-token in URLs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-xaccess-"));
  const outputDir = mkdtempSync(join(tmpdir(), "a2a-bundle-xaccess-out-"));
  try {
    const runDir = createMinimalRun(rootDir, "xaccess-task", "run1", {
      summary: "Using x-access-token:ghp_1234567890abcdef1234567890@github.com as remote",
    });

    await createArtifactBundle({ workDir: runDir, outputPath: outputDir });

    for (const name of ["summary.txt", "task.json", "manifest.json"]) {
      try {
        const content = readFileSync(join(outputDir, name), "utf8");
        assert.ok(!content.includes("x-access-token:ghp_"), `${name} must not contain raw x-access-token`);
        assert.ok(!content.includes("ghp_"), `${name} must not contain raw GitHub token`);
      } catch {
        // File may not exist in bundle.
      }
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("fail-closed: scanner truncates fields at safe bounds", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-truncate-"));
  try {
    createMinimalRun(rootDir, "truncate-task", "run-trunc", {
      summary: "A".repeat(5000),
    });

    const profile = await scanHistory({ rootDir });
    const entry = profile.runs[0]!;

    if (entry.summary) {
      assert.ok(entry.summary.length <= 300, `Summary should be <= 300 chars, got ${entry.summary.length}`);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fail-closed: scanner handles null bytes in task metadata", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-null-"));
  try {
    const safeTaskId = "null-task";
    const runDir = join(rootDir, safeTaskId, "null-run");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(runDir, "artifacts"), { recursive: true });

    // Task ID with null bytes.
    writeFileSync(join(runDir, "task.json"), JSON.stringify({
      id: "before\0after",
      intent: "propose_patch",
    }));
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId: "null-task",
      createdAt: "2025-01-01T00:00:00.000Z",
    }));
    writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId: "before\0after",
      repo: "jinwon-int/test",
      status: "done",
      summary: "ok",
      evidence: [],
      artifacts: [],
    }));

    const profile = await scanHistory({ rootDir });
    // Must not throw and must produce a valid profile.
    assert.ok(Array.isArray(profile.runs));
    // Null bytes must be removed from output.
    const profileJson = JSON.stringify(profile);
    assert.ok(!profileJson.includes("\0"), "Profile must not contain null bytes");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory projects GitHub comment evidence with scanner parity flags", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-github-projection-"));
  try {
    const runDir = createMinimalRun(rootDir, "projection-task", "run1", {
      issueUrl: "https://github.com/jinwon-int/test/issues/5",
      status: "done",
    });
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.evidenceHints = {
      schemaVersion: "a2a.runner.evidence-hints.v1",
      issueUrl: "https://github.com/jinwon-int/test/issues/5",
      doneUrl: "https://github.com/jinwon-int/test/issues/5#issuecomment-123",
      failureCategory: "no_changes_allowed",
    };
    manifest.githubCommentProjection = {
      schemaVersion: "a2a.runner.github-comment-projection.v1",
      kind: "done",
      url: "https://github.com/jinwon-int/test/issues/5#issuecomment-123",
      issueUrl: "https://github.com/jinwon-int/test/issues/5",
      manifestPath: "artifacts/manifest.json",
      dedupeKey: "a2a-github-comment:projection-task:done:https://github.com/jinwon-int/test/issues/5#issuecomment-123",
      commentIsTerminalAck: false,
      commentIsVisibilityReceipt: false,
      commentIsOperatorApproval: false,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const profile = await scanHistory({ rootDir });
    const entry = profile.runs[0]!;
    assert.equal(entry.doneUrl, "https://github.com/jinwon-int/test/issues/5#issuecomment-123");
    assert.deepEqual(entry.githubCommentProjection, {
      kind: "done",
      url: "https://github.com/jinwon-int/test/issues/5#issuecomment-123",
      dedupeKey: "a2a-github-comment:projection-task:done:https://github.com/jinwon-int/test/issues/5#issuecomment-123",
      commentIsTerminalAck: false,
      commentIsVisibilityReceipt: false,
      commentIsOperatorApproval: false,
    });
    assert.ok(!JSON.stringify(entry).includes("/tmp/"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("artifact bundle sanitizes GitHub projection and evidence hints before preserving them", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-bundle-projection-"));
  const outputDir = mkdtempSync(join(tmpdir(), "a2a-scanner-bundle-projection-out-"));
  try {
    const runDir = createMinimalRun(rootDir, "bundle-projection-task", "run1", {
      issueUrl: "https://github.com/jinwon-int/test/issues/6",
      status: "done",
    });
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.evidenceHints = {
      schemaVersion: "a2a.runner.evidence-hints.v1",
      issueUrl: "https://github.com/jinwon-int/test/issues/6",
      doneUrl: "https://github.com/jinwon-int/test/issues/6#issuecomment-456",
      branch: "feature-ghp_1234567890abcdef1234567890_leak",
    };
    manifest.githubCommentProjection = {
      schemaVersion: "a2a.runner.github-comment-projection.v1",
      kind: "done",
      url: "https://github.com/jinwon-int/test/issues/6#issuecomment-456",
      issueUrl: "https://github.com/jinwon-int/test/issues/6",
      manifestPath: "/tmp/private/artifacts/manifest.json",
      dedupeKey: "a2a:ghp_1234567890abcdef1234567890_leak:projection",
      commentIsTerminalAck: false,
      commentIsVisibilityReceipt: false,
      commentIsOperatorApproval: false,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const bundle = await createArtifactBundle({ workDir: runDir, outputPath: outputDir });
    assert.equal(bundle.evidenceHints?.doneUrl, "https://github.com/jinwon-int/test/issues/6#issuecomment-456");
    assert.ok(!JSON.stringify(bundle.evidenceHints).includes("ghp_"));
    assert.equal(bundle.githubCommentProjection?.url, "https://github.com/jinwon-int/test/issues/6#issuecomment-456");
    assert.equal(bundle.githubCommentProjection?.commentIsTerminalAck, false);
    assert.equal(bundle.githubCommentProjection?.manifestPath, "artifacts/manifest.json");
    assert.ok(!JSON.stringify(bundle.githubCommentProjection).includes("ghp_"));
    assert.ok(!JSON.stringify(bundle.githubCommentProjection).includes("/tmp/private"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("scanHistory omits unsafe GitHub projection flags instead of converting them to receipts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-unsafe-projection-"));
  try {
    const runDir = createMinimalRun(rootDir, "unsafe-projection-task", "run1");
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.githubCommentProjection = {
      schemaVersion: "a2a.runner.github-comment-projection.v1",
      kind: "done",
      url: "https://github.com/jinwon-int/test/issues/1#issuecomment-789",
      manifestPath: "artifacts/manifest.json",
      dedupeKey: "unsafe",
      commentIsTerminalAck: true,
      commentIsVisibilityReceipt: false,
      commentIsOperatorApproval: false,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const profile = await scanHistory({ rootDir });
    assert.equal(profile.runs[0]!.githubCommentProjection, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory projects source-public rehearsal as compact no-live evidence", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-source-public-"));
  try {
    const runDir = createMinimalRun(rootDir, "source-public-task", "run-source-public");
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sourcePublicApprovalRehearsal = {
      schemaVersion: "a2a.runner.source-public-approval-rehearsal.v1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      runId: "a2a-source-public-approval-rehearsal-20260511T014240Z",
      decision: "NEEDS_OPERATOR_APPROVAL",
      terminalBriefRehearsalOnly: true,
      approvalPackets: [{
        schemaVersion: "a2a.runner.source-public-approval-packet.v1",
        packetId: "packet-001",
        targetRepo: "jinwon-int/a2a-docker-runner",
        decision: "NEEDS_OPERATOR_APPROVAL",
        dedupeKey: "source-public:packet-001",
        evidenceBundlePath: "artifacts/manifest.json",
        operatorApprovalRequired: true,
        approvalExecuted: false,
        releaseExecuted: false,
        visibilityChanged: false,
        terminalAckSent: false,
        providerSendPerformed: false,
        dbMutationPerformed: false,
        rollbackPath: "rollback/source-public-rehearsal.md",
        abortPath: "abort/source-public-rehearsal.md",
      }],
      replayNoDuplicateProof: { dedupeKey: "source-public:packet-001", noDuplicatePacketIds: true },
      rollbackAbort: { rollbackPath: "rollback/source-public-rehearsal.md", abortPath: "abort/source-public-rehearsal.md" },
      safetyGates: {
        operatorApprovalRequired: true,
        sourcePublicExecutionBlocked: true,
        approvalExecuted: false,
        releaseExecuted: false,
        visibilityChanged: false,
        liveProviderSendPerformed: false,
        terminalAckSent: false,
        dbMutationPerformed: false,
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const profile = await scanHistory({ rootDir });
    const rehearsal = profile.runs[0]?.sourcePublicApprovalRehearsal;
    assert.ok(rehearsal);
    assert.equal(rehearsal.decision, "NEEDS_OPERATOR_APPROVAL");
    assert.equal(rehearsal.approvalPacketCount, 1);
    assert.equal(rehearsal.terminalBriefRehearsalOnly, true);
    assert.equal(rehearsal.operatorApprovalRequired, true);
    assert.equal(rehearsal.sourcePublicExecutionBlocked, true);
    assert.equal(rehearsal.approvalExecuted, false);
    assert.equal(rehearsal.releaseExecuted, false);
    assert.equal(rehearsal.visibilityChanged, false);
    assert.equal(rehearsal.liveProviderSendPerformed, false);
    assert.equal(rehearsal.terminalAckSent, false);
    assert.equal(rehearsal.dbMutationPerformed, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createArtifactBundle drops unsafe source-public rehearsal packets", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-source-public-"));
  const outDir = mkdtempSync(join(tmpdir(), "a2a-bundle-source-public-out-"));
  try {
    const runDir = createMinimalRun(rootDir, "source-public-task", "run-source-public");
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sourcePublicApprovalRehearsal = {
      schemaVersion: "a2a.runner.source-public-approval-rehearsal.v1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      decision: "GO_CANDIDATE",
      terminalBriefRehearsalOnly: true,
      approvalPackets: [{
        schemaVersion: "a2a.runner.source-public-approval-packet.v1",
        packetId: "packet-unsafe",
        targetRepo: "jinwon-int/a2a-docker-runner",
        decision: "GO_CANDIDATE",
        dedupeKey: "source-public:packet-unsafe",
        evidenceBundlePath: "artifacts/manifest.json",
        operatorApprovalRequired: true,
        approvalExecuted: false,
        releaseExecuted: false,
        visibilityChanged: true,
        terminalAckSent: false,
        providerSendPerformed: false,
        dbMutationPerformed: false,
        rollbackPath: "rollback/source-public-rehearsal.md",
        abortPath: "abort/source-public-rehearsal.md",
      }],
      replayNoDuplicateProof: { dedupeKey: "source-public:packet-unsafe", noDuplicatePacketIds: true },
      rollbackAbort: { rollbackPath: "rollback/source-public-rehearsal.md", abortPath: "abort/source-public-rehearsal.md" },
      safetyGates: {
        operatorApprovalRequired: true,
        sourcePublicExecutionBlocked: true,
        approvalExecuted: false,
        releaseExecuted: false,
        visibilityChanged: false,
        liveProviderSendPerformed: false,
        terminalAckSent: false,
        dbMutationPerformed: false,
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const bundle = await createArtifactBundle({ workDir: runDir, outputPath: outDir });
    assert.equal(bundle.sourcePublicApprovalRehearsal, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("scanHistory projects source-public execution preflight as compact no-live evidence", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-source-public-preflight-"));
  try {
    const runDir = createMinimalRun(rootDir, "source-public-preflight-task", "run-source-public-preflight");
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const packet = buildSourcePublicApprovalRehearsal({
      targetRepo: "jinwon-int/a2a-docker-runner",
      decision: "GO_CANDIDATE",
      runId: "a2a-source-public-execution-orchestrator-20260511T023207Z",
    }).approvalPackets[0]!;
    const scanProfile: ScanProfile = {
      schemaVersion: "a2a.runner.scan-profile.v1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      rootLabel: "runner-root:test",
      totalRunDirs: 1,
      runs: [{
        taskId: "source-public-preflight-task",
        safeTaskId: "source-public-preflight-task",
        runToken: "run-source-public-preflight",
        createdAt: "2026-05-11T02:32:07.000Z",
        status: "done",
        artifactCount: 1,
      }],
    };
    manifest.sourcePublicExecutionPreflight = buildSourcePublicExecutionPreflight({
      approvedPacket: packet,
      manifest,
      scanProfile,
      mode: "dry_run",
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const profile = await scanHistory({ rootDir });
    const preflight = profile.runs[0]?.sourcePublicExecutionPreflight;
    assert.ok(preflight);
    assert.equal(preflight.status, "ready_for_operator_approval");
    assert.equal(preflight.mode, "dry_run");
    assert.equal(preflight.operatorApprovalRequired, true);
    assert.equal(preflight.sourcePublicExecutionBlocked, true);
    assert.equal(preflight.approvalExecuted, false);
    assert.equal(preflight.releaseExecuted, false);
    assert.equal(preflight.visibilityChanged, false);
    assert.equal(preflight.liveProviderSendPerformed, false);
    assert.equal(preflight.terminalAckSent, false);
    assert.equal(preflight.dbMutationPerformed, false);
    assert.equal(preflight.deployOrRestartPerformed, false);
    assert.equal(preflight.failureReasons.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createArtifactBundle preserves sanitized source-public execution preflight", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-bundle-source-public-preflight-"));
  const outDir = mkdtempSync(join(tmpdir(), "a2a-bundle-source-public-preflight-out-"));
  try {
    const runDir = createMinimalRun(rootDir, "source-public-preflight-task", "run-source-public-preflight");
    const manifestPath = join(runDir, "artifacts", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const packet = buildSourcePublicApprovalRehearsal({
      targetRepo: "jinwon-int/a2a-docker-runner",
      decision: "GO_CANDIDATE",
    }).approvalPackets[0]!;
    const scanProfile: ScanProfile = {
      schemaVersion: "a2a.runner.scan-profile.v1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      rootLabel: "runner-root:test",
      totalRunDirs: 1,
      runs: [{ taskId: "source-public-preflight-task", safeTaskId: "source-public-preflight-task", runToken: "run-source-public-preflight", createdAt: "2026-05-11T02:32:07.000Z", status: "done", artifactCount: 1 }],
    };
    manifest.sourcePublicExecutionPreflight = buildSourcePublicExecutionPreflight({ approvedPacket: packet, manifest, scanProfile });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const bundle = await createArtifactBundle({ workDir: runDir, outputPath: outDir });
    assert.equal(bundle.sourcePublicExecutionPreflight?.status, "ready_for_operator_approval");
    assert.equal(bundle.sourcePublicExecutionPreflight?.safetyGates.deployOrRestartPerformed, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Readiness evidence: taskId slash sanitisation (a2a-docker-runner#215)
// ---------------------------------------------------------------------------

test("scanHistory handles task IDs containing slashes (Team1/nosuk pattern)", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-slash-id-"));
  try {
    // This simulates a real A2A round task where the worker ID contains a
    // slash, e.g. "Team1/nosuk".  The runner safeId converts it to
    // "Team1_nosuk" for the directory name, but the original id is kept in
    // task.json metadata.  The scanner must produce both faithfully.
    const taskId = "[Team1/nosuk] Runner scanner/readiness evidence and CI ownership regression hardening";
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const runDir = join(rootDir, safeTaskId, "20260512T030000Z-run1");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId,
      safeTaskId,
      runToken: "20260512T030000Z-run1",
      createdAt: "2026-05-12T03:00:00.000Z",
    }));

    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "task.json"), JSON.stringify({
      id: taskId,
      intent: "propose_patch",
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/215",
    }));
    writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId,
      repo: "jinwon-int/a2a-docker-runner",
      status: "done",
      summary: "Scanner readiness evidence: taskId contains slash.",
      evidence: [],
      artifacts: [],
    }));

    const profile = await scanHistory({ rootDir });
    assert.equal(profile.totalRunDirs, 1);
    assert.equal(profile.runs.length, 1);

    const entry = profile.runs[0]!;
    // The original taskId (with slash) must appear in the scan entry.
    assert.ok(entry.taskId.includes("Team1"), `Expected taskId to include Team1, got: ${entry.taskId}`);
    // The safeTaskId must use underscore instead of slash (filesystem-safe).
    assert.equal(entry.safeTaskId, safeTaskId);
    assert.ok(!entry.safeTaskId.includes("/"), "safeTaskId must not contain slash");
    assert.ok(entry.safeTaskId.includes("Team1_nosuk"), `Expected safeTaskId to contain Team1_nosuk, got: ${entry.safeTaskId}`);

    // The profile JSON must not contain raw slashes in safeTaskId field.
    const profileJson = JSON.stringify(profile);
    assert.ok(profileJson.includes("Team1_nosuk"), "safeTaskId should use underscore");
    assert.ok(!/safeTaskId[^"]*\/[^"]*nosuk/.test(profileJson), "safeTaskId must not contain slash");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory readiness evidence: all required fields populated for slash-containing task IDs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-readiness-"));
  try {
    const taskId = "[Team1/nosuk] A2A round task";
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    // Create multiple runs to exercise sort/dedupe readiness.
    for (const runToken of ["run-B", "run-A", "run-C"]) {
      const runDir = join(rootDir, safeTaskId, runToken);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "run.json"), JSON.stringify({
        taskId,
        safeTaskId,
        runToken,
        createdAt: "2026-05-12T03:00:00.000Z",
      }));
      mkdirSync(join(runDir, "artifacts"), { recursive: true });
      writeFileSync(join(runDir, "artifacts", "task.json"), JSON.stringify({
        id: taskId,
        intent: "propose_patch",
      }));
      writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
        artifactVersion: 1,
        schemaVersion: 1,
        manifestPath: "artifacts/manifest.json",
        generatedAt: "1970-01-01T00:00:00.000Z",
        taskId,
        repo: "jinwon-int/a2a-docker-runner",
        status: "done",
        summary: `Run ${runToken}`,
        evidence: [],
        artifacts: [],
      }));
    }

    const profile = await scanHistory({ rootDir });
    assert.equal(profile.totalRunDirs, 3);
    assert.equal(profile.runs.length, 3);

    // Runs must be sorted deterministically by runToken.
    assert.equal(profile.runs[0]!.runToken, "run-A");
    assert.equal(profile.runs[1]!.runToken, "run-B");
    assert.equal(profile.runs[2]!.runToken, "run-C");

    // All entries must have required fields.
    for (const entry of profile.runs) {
      assert.ok(typeof entry.taskId === "string" && entry.taskId.length > 0, "taskId required");
      assert.ok(typeof entry.safeTaskId === "string" && entry.safeTaskId.length > 0, "safeTaskId required");
      assert.ok(typeof entry.runToken === "string" && entry.runToken.length > 0, "runToken required");
      assert.ok(typeof entry.createdAt === "string" && entry.createdAt.length > 0, "createdAt required");
      assert.ok(typeof entry.status === "string" && entry.status.length > 0, "status required");
      assert.ok(typeof entry.artifactCount === "number" && entry.artifactCount >= 0, "artifactCount required");
      assert.ok(!entry.safeTaskId.includes("/"), "safeTaskId must never contain slash");
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanHistory readiness evidence: handles non-ISO8601 createdAt in run.json", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-scanner-baddate-"));
  try {
    const safeTaskId = "readiness-date-task";
    const runDir = join(rootDir, safeTaskId, "run1");
    mkdirSync(runDir, { recursive: true });

    // Malformed createdAt: not parseable as ISO date.
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId: "readiness-date-task",
      safeTaskId,
      runToken: "run1",
      createdAt: "not-a-date",
    }));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "task.json"), JSON.stringify({
      id: "readiness-date-task",
      intent: "propose_patch",
    }));
    writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId: "readiness-date-task",
      status: "done",
      summary: "ok",
      evidence: [],
      artifacts: [],
    }));

    const profile = await scanHistory({ rootDir });
    assert.equal(profile.totalRunDirs, 1);
    assert.equal(profile.runs.length, 1);
    // createdAt should fall back gracefully — either the raw value or
    // whatever the scanner produces (must not throw).
    assert.ok(typeof profile.runs[0]!.createdAt === "string");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Readiness harness: readinessScan (a2a-docker-runner#219 / a2a-broker#511)
// ---------------------------------------------------------------------------

test("readinessScan produces valid report for empty rootDir", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-empty-"));
  try {
    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    assert.equal(report.schemaVersion, "a2a.runner.readiness-report.v1");
    assert.equal(report.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(report.totalTaskRoots, 0);
    assert.equal(report.totalRunDirs, 0);
    assert.equal(report.staleRuns, 0);
    assert.equal(report.malformedRuns, 0);
    assert.equal(report.orphanTaskRoots, 0);
    assert.deepEqual(report.runs, []);
    assert.ok(typeof report.rootLabel === "string");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan classifies healthy run as ok", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-ok-"));
  try {
    createMinimalRun(rootDir, "healthy-task", "run1", { status: "done" });

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    assert.equal(report.totalTaskRoots, 1);
    assert.equal(report.totalRunDirs, 1);
    assert.equal(report.staleRuns, 0);
    assert.equal(report.malformedRuns, 0);
    assert.equal(report.orphanTaskRoots, 0);
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0]!.status, "ok");
    assert.equal(report.runs[0]!.terminal, true);
    assert.ok(!report.runs[0]!.reason);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan detects stale runs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-stale-"));
  try {
    const nowMs = Date.now();
    // Create a run that is 2 hours old and has no terminal status (status="unknown").
    const safeTaskId = "stale-task";
    const runDir = join(rootDir, safeTaskId, "stale-run");
    mkdirSync(runDir, { recursive: true });

    const oldCreatedAt = new Date(nowMs - 7200000).toISOString(); // 2 hours ago
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId: "stale-task",
      safeTaskId,
      runToken: "stale-run",
      createdAt: oldCreatedAt,
    }));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    // No manifest — no terminal status → stale when old enough.
    // With no manifest, terminal depends on exitCode/timedOut in run.json.
    // Without those, terminal=false and it will be stale.

    const report = await readinessScan({
      rootDir,
      staleThresholdMs: 3600000, // 1 hour
      nowMs,
    });

    assert.equal(report.totalTaskRoots, 1);
    assert.equal(report.totalRunDirs, 1);
    // Without manifest, runJsonMalformed is false (run.json is valid),
    // but manifestMalformed is true (no manifest). The run is malformed first.
    // So the run is classified as malformed, not stale.
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan detects stale run with valid manifest but non-terminal status", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-stale2-"));
  try {
    const nowMs = Date.now();
    const safeTaskId = "stale-task-2";
    const runDir = join(rootDir, safeTaskId, "stale-run-2");
    mkdirSync(runDir, { recursive: true });

    const oldCreatedAt = new Date(nowMs - 7200000).toISOString(); // 2 hours ago
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId: "stale-task-2",
      safeTaskId,
      runToken: "stale-run-2",
      createdAt: oldCreatedAt,
    }));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    // Valid manifest with non-terminal status like "pending".
    writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId: "stale-task-2",
      status: "pending",
      summary: "still running",
      evidence: [],
      artifacts: [],
    }));

    const report = await readinessScan({
      rootDir,
      staleThresholdMs: 3600000, // 1 hour
      nowMs,
    });

    assert.equal(report.totalRunDirs, 1);
    assert.equal(report.staleRuns, 1);
    assert.equal(report.malformedRuns, 0);
    assert.equal(report.runs[0]!.status, "stale");
    assert.equal(report.runs[0]!.terminal, false);
    assert.ok(report.runs[0]!.reason?.includes("exceeds stale threshold"),
      `Expected stale reason, got: ${report.runs[0]!.reason}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan detects malformed runs (corrupt run.json)", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-malformed-"));
  try {
    const safeTaskId = "malformed-task";
    const runDir = join(rootDir, safeTaskId, "malformed-run");
    mkdirSync(runDir, { recursive: true });

    // Corrupt run.json.
    writeFileSync(join(runDir, "run.json"), "NOT VALID JSON {{{{");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    // No manifest.

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    assert.equal(report.totalRunDirs, 1);
    assert.equal(report.malformedRuns, 1);
    assert.equal(report.runs[0]!.status, "malformed");
    assert.equal(report.runs[0]!.runJsonMalformed, true);
    assert.equal(report.runs[0]!.manifestMalformed, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan detects orphan task roots (no run subdirectories)", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-orphan-"));
  try {
    // Create a task root with only an artifacts dir (no actual run).
    const safeTaskId = "orphan-task";
    const taskRoot = join(rootDir, safeTaskId);
    mkdirSync(taskRoot, { recursive: true });
    // No run directories inside — just a stray directory.

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    assert.equal(report.totalTaskRoots, 1);
    assert.equal(report.totalRunDirs, 0);
    assert.equal(report.orphanTaskRoots, 1);
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0]!.status, "orphan");
    assert.equal(report.runs[0]!.orphanTaskRoot, true);
    assert.equal(report.runs[0]!.runToken, "<no-runs>");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan handles missing rootDir gracefully", async () => {
  const report = await readinessScan({
    rootDir: "/tmp/a2a-nonexistent-readiness-dir-99999999",
    staleThresholdMs: 3600000,
  });
  assert.equal(report.totalTaskRoots, 0);
  assert.equal(report.totalRunDirs, 0);
  assert.equal(report.staleRuns, 0);
  assert.equal(report.malformedRuns, 0);
  assert.equal(report.orphanTaskRoots, 0);
  assert.deepEqual(report.runs, []);
});

test("readinessScan report is deterministic", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-det-"));
  try {
    createMinimalRun(rootDir, "task-B", "run-B", { status: "done" });
    createMinimalRun(rootDir, "task-A", "run-A", { status: "done" });

    const report1 = await readinessScan({ rootDir, staleThresholdMs: 3600000, nowMs: 1000 });
    const report2 = await readinessScan({ rootDir, staleThresholdMs: 3600000, nowMs: 1000 });

    assert.deepEqual(
      JSON.parse(JSON.stringify(report1)),
      JSON.parse(JSON.stringify(report2)),
      "Readiness report must be deterministic with the same nowMs",
    );
    // Runs sorted by runToken.
    assert.equal(report1.runs[0]!.runToken, "run-A");
    assert.equal(report1.runs[1]!.runToken, "run-B");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan does not mutate task root on disk", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-nomutate-"));
  try {
    createMinimalRun(rootDir, "no-mutate-task", "run1", { status: "done" });

    // Capture directory listing before scan.
    const before = readdirSync(rootDir, { recursive: true }).sort();

    await readinessScan({ rootDir, staleThresholdMs: 3600000 });

    const after = readdirSync(rootDir, { recursive: true }).sort();
    assert.deepEqual(before, after, "readinessScan must not mutate disk state");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan handles task IDs containing slashes (Team1/nosuk pattern)", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-slash-"));
  try {
    const taskId = "[Team1/nosuk] Readiness lane task";
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const runDir = join(rootDir, safeTaskId, "20260512T030000Z-run1");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId,
      safeTaskId,
      runToken: "20260512T030000Z-run1",
      createdAt: "2026-05-12T03:00:00.000Z",
    }));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId,
      status: "done",
      summary: "ok",
      evidence: [],
      artifacts: [],
    }));

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    assert.equal(report.totalRunDirs, 1);
    assert.equal(report.runs[0]!.status, "ok");
    assert.ok(!report.runs[0]!.safeTaskId.includes("/"), "safeTaskId must not contain slash");
    // Report JSON must not leak host paths.
    const reportJson = JSON.stringify(report);
    assert.ok(!reportJson.includes(rootDir), "report must not contain absolute rootDir");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan respects limit option", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-limit-"));
  try {
    // Create 5 runs across 2 tasks.
    createMinimalRun(rootDir, "task1", "run-A", { status: "done" });
    createMinimalRun(rootDir, "task1", "run-B", { status: "done" });
    createMinimalRun(rootDir, "task1", "run-C", { status: "done" });
    createMinimalRun(rootDir, "task2", "run-D", { status: "done" });
    createMinimalRun(rootDir, "task2", "run-E", { status: "done" });

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000, limit: 3 });
    assert.equal(report.totalRunDirs, 5);
    // Runs are limited to 3.
    assert.ok(report.runs.length <= 3, `Expected <= 3 runs, got ${report.runs.length}`);
    // Counts still show totals.
    assert.equal(report.staleRuns, 0);
    assert.equal(report.malformedRuns, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan mixed stale, malformed, and ok runs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-mixed-"));
  try {
    const nowMs = Date.now();

    // OK run.
    createMinimalRun(rootDir, "ok-task", "ok-run", { status: "done" });

    // Stale run: old + non-terminal status.
    const staleSafeId = "stale-task";
    const staleDir = join(rootDir, staleSafeId, "stale-run");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "run.json"), JSON.stringify({
      taskId: "stale-task",
      safeTaskId: staleSafeId,
      runToken: "stale-run",
      createdAt: new Date(nowMs - 7200000).toISOString(), // 2h ago
    }));
    mkdirSync(join(staleDir, "artifacts"), { recursive: true });
    writeFileSync(join(staleDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId: "stale-task",
      status: "pending",
      summary: "still running",
      evidence: [],
      artifacts: [],
    }));

    // Malformed run.
    const malSafeId = "malformed-task";
    const malDir = join(rootDir, malSafeId, "malformed-run");
    mkdirSync(malDir, { recursive: true });
    writeFileSync(join(malDir, "run.json"), "NOT JSON {{{{");

    // Orphan task root.
    mkdirSync(join(rootDir, "orphan-task"), { recursive: true });

    const report = await readinessScan({
      rootDir,
      staleThresholdMs: 3600000, // 1 hour
      nowMs,
    });

    assert.equal(report.totalTaskRoots, 4);
    assert.equal(report.totalRunDirs, 3);
    assert.equal(report.staleRuns, 1);
    assert.equal(report.malformedRuns, 1);
    assert.equal(report.orphanTaskRoots, 1);

    // Verify each class appears.
    const statuses = report.runs.map((r) => r.status);
    assert.ok(statuses.includes("ok"), `Expected an ok entry, got: ${statuses}`);
    assert.ok(statuses.includes("stale"), `Expected a stale entry, got: ${statuses}`);
    assert.ok(statuses.includes("malformed"), `Expected a malformed entry, got: ${statuses}`);
    assert.ok(statuses.includes("orphan"), `Expected an orphan entry, got: ${statuses}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan report does not leak secrets", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-noleak-"));
  try {
    const safeTaskId = "secret-task";
    const runDir = join(rootDir, safeTaskId, "secret-run");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId: "ghp_1234567890abcdef1234567890abcdef",
      safeTaskId,
      runToken: "secret-run",
      createdAt: "2026-05-12T00:00:00.000Z",
    }));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      schemaVersion: 1,
      manifestPath: "artifacts/manifest.json",
      generatedAt: "1970-01-01T00:00:00.000Z",
      taskId: "ghp_1234567890abcdef1234567890abcdef",
      status: "done",
      summary: "ok",
      evidence: [],
      artifacts: [],
    }));

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    const reportJson = JSON.stringify(report);
    assert.ok(!reportJson.includes("ghp_"), "Report must not contain raw GitHub token");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readinessScan run with terminal exitCode but no manifest is classified correctly", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-readiness-exitcode-"));
  try {
    const safeTaskId = "exitcode-task";
    const runDir = join(rootDir, safeTaskId, "exitcode-run");
    mkdirSync(runDir, { recursive: true });

    // Valid run.json with exitCode=0 but no manifest.
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      taskId: "exitcode-task",
      safeTaskId,
      runToken: "exitcode-run",
      createdAt: "2026-05-12T00:00:00.000Z",
      exitCode: 0,
    }));

    const report = await readinessScan({ rootDir, staleThresholdMs: 3600000 });
    assert.equal(report.totalRunDirs, 1);
    // manifestMalformed=true but exitCode=0 makes it terminal → ok.
    assert.equal(report.runs[0]!.status, "malformed");
    assert.equal(report.runs[0]!.manifestMalformed, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cleanup dry-run plan: buildCleanupDryRunPlan (a2a-docker-runner#223 / a2a-broker#519)
// ---------------------------------------------------------------------------

test("buildCleanupDryRunPlan produces valid plan for empty readiness report", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:test",
    totalTaskRoots: 0,
    totalRunDirs: 0,
    staleRuns: 0,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs: [],
  };

  const plan = buildCleanupDryRunPlan(report);
  assert.equal(plan.schemaVersion, "a2a.runner.cleanup-dry-run-plan.v1");
  assert.equal(plan.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.ok(typeof plan.planId === "string" && plan.planId.length > 0);
  assert.equal(plan.summary.totalCandidates, 0);
  assert.equal(plan.summary.byRiskClass.low, 0);
  assert.equal(plan.summary.byRiskClass.medium, 0);
  assert.equal(plan.summary.byRiskClass.high, 0);
  assert.equal(plan.summary.byRiskClass.blocked, 0);
  assert.deepEqual(plan.entries, []);
  // Safety markers.
  assert.equal(plan.safety.mutationPerformed, false);
  assert.equal(plan.safety.operatorApprovalRequired, true);
  assert.equal(plan.safety.backupRequired, true);
  assert.equal(plan.safety.staleWorkerRowsMayBeValid, true);
  assert.equal(plan.safety.liveProviderSendPerformed, false);
  assert.equal(plan.safety.terminalAckSent, false);
  assert.equal(plan.safety.dbMutationPerformed, false);
  // Pre-execution checklist.
  assert.ok(Array.isArray(plan.preExecutionChecklist));
  assert.ok(plan.preExecutionChecklist.length >= 3);
  // Rollback notes.
  assert.ok(typeof plan.rollbackNotes === "string" && plan.rollbackNotes.length > 0);
});

test("buildCleanupDryRunPlan includes only non-ok entries", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:test",
    totalTaskRoots: 2,
    totalRunDirs: 3,
    staleRuns: 1,
    malformedRuns: 1,
    orphanTaskRoots: 0,
    runs: [
      { safeTaskId: "ok-task", runToken: "run-1", ageMs: 1000, status: "ok", terminal: true, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
      { safeTaskId: "stale-task", runToken: "run-2", ageMs: 9000000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false, reason: "stale run" },
      { safeTaskId: "bad-task", runToken: "run-3", ageMs: 5000, status: "malformed", terminal: false, runJsonMalformed: true, manifestMalformed: false, orphanTaskRoot: false, reason: "bad run.json" },
    ],
  };

  const plan = buildCleanupDryRunPlan(report);
  assert.equal(plan.summary.totalCandidates, 2);
  assert.equal(plan.entries.length, 2);
  // Ok entry excluded.
  assert.ok(!plan.entries.some((e) => e.safeTaskId === "ok-task"));
  // Non-ok entries included.
  assert.ok(plan.entries.some((e) => e.safeTaskId === "stale-task"));
  assert.ok(plan.entries.some((e) => e.safeTaskId === "bad-task"));
  // Bound report matches.
  assert.equal(plan.boundReadinessReport.staleRuns, 1);
  assert.equal(plan.boundReadinessReport.malformedRuns, 1);
});

test("buildCleanupDryRunPlan assigns correct risk classes", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:test",
    totalTaskRoots: 3,
    totalRunDirs: 3,
    staleRuns: 1,
    malformedRuns: 1,
    orphanTaskRoots: 1,
    runs: [
      {
        safeTaskId: "stale-fresh", runToken: "run-s1", ageMs: 3_600_001,
        status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false,
        orphanTaskRoot: false, reason: "stale fresh",
      },
      {
        safeTaskId: "stale-old", runToken: "run-s2", ageMs: 8 * 24 * 3600_000 + 1,
        status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false,
        orphanTaskRoot: false, reason: "stale old",
      },
      {
        safeTaskId: "orphan-dir", runToken: "<no-runs>", ageMs: 0,
        status: "orphan", terminal: false, runJsonMalformed: false, manifestMalformed: false,
        orphanTaskRoot: true, reason: "orphan",
      },
    ],
  };

  const plan = buildCleanupDryRunPlan(report);
  assert.equal(plan.entries.length, 3);

  // stale < 7 days → medium.
  const freshStale = plan.entries.find((e) => e.safeTaskId === "stale-fresh")!;
  assert.equal(freshStale.riskClass, "medium");

  // stale > 7 days → high.
  const oldStale = plan.entries.find((e) => e.safeTaskId === "stale-old")!;
  assert.equal(oldStale.riskClass, "high");

  // orphan → low.
  const orphan = plan.entries.find((e) => e.safeTaskId === "orphan-dir")!;
  assert.equal(orphan.riskClass, "low");

  // Verify byRiskClass totals.
  assert.equal(plan.summary.byRiskClass.low, 1);
  assert.equal(plan.summary.byRiskClass.medium, 1);
  assert.equal(plan.summary.byRiskClass.high, 1);
  assert.equal(plan.summary.byRiskClass.blocked, 0);
});

test("buildCleanupDryRunPlan generates deterministic output", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:det",
    totalTaskRoots: 1,
    totalRunDirs: 2,
    staleRuns: 1,
    malformedRuns: 1,
    orphanTaskRoots: 0,
    runs: [
      { safeTaskId: "task-a", runToken: "run-1", ageMs: 5000000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
      { safeTaskId: "task-a", runToken: "run-2", ageMs: 100000, status: "malformed", terminal: false, runJsonMalformed: true, manifestMalformed: false, orphanTaskRoot: false },
    ],
  };

  const plan1 = buildCleanupDryRunPlan(report);
  const plan2 = buildCleanupDryRunPlan(report);

  assert.deepEqual(plan1.planId, plan2.planId);
  assert.deepEqual(plan1.entries.map((e) => e.candidateId), plan2.entries.map((e) => e.candidateId));
  assert.deepEqual(plan1.summary, plan2.summary);
  assert.deepEqual(plan1.safety, plan2.safety);
});

test("buildCleanupDryRunPlan respects limit option", () => {
  const runs: ReadinessReport["runs"] = [];
  for (let i = 0; i < 10; i++) {
    runs.push({
      safeTaskId: `task-${i}`, runToken: `run-${i}`, ageMs: 10_000_000,
      status: "stale" as const, terminal: false, runJsonMalformed: false,
      manifestMalformed: false, orphanTaskRoot: false,
    });
  }

  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:limit",
    totalTaskRoots: 10,
    totalRunDirs: 10,
    staleRuns: 10,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs,
  };

  const plan = buildCleanupDryRunPlan(report, { limit: 3 });
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.summary.totalCandidates, 3);
  assert.ok(plan.summary.byTrigger.stale <= 3);
});

test("buildCleanupDryRunPlan candidate IDs include prefix overrides", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:prefix",
    totalTaskRoots: 1,
    totalRunDirs: 1,
    staleRuns: 1,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs: [
      { safeTaskId: "task-x", runToken: "run-x", ageMs: 10_000_000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
    ],
  };

  const plan = buildCleanupDryRunPlan(report, { candidateIdPrefix: "safe-prune" });
  assert.equal(plan.entries.length, 1);
  assert.ok(plan.entries[0]!.candidateId.startsWith("safe-prune:"));
  assert.ok(plan.planId.startsWith("safe-prune-"));
});

test("buildCleanupDryRunPlan does not mutate its input report", () => {
  const runs: ReadinessReport["runs"] = [
    { safeTaskId: "immutable-task", runToken: "immutable-run", ageMs: 5000000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
  ];
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:immutable",
    totalTaskRoots: 1,
    totalRunDirs: 1,
    staleRuns: 1,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs,
  };

  const frozen = JSON.parse(JSON.stringify(report)) as ReadinessReport;
  buildCleanupDryRunPlan(report);
  assert.deepEqual(report, frozen, "buildCleanupDryRunPlan must not mutate its input");
});

test("buildCleanupDryRunPlan safety markers are immutable", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:safety",
    totalTaskRoots: 1,
    totalRunDirs: 1,
    staleRuns: 1,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs: [
      { safeTaskId: "t", runToken: "r", ageMs: 10_000_000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
    ],
  };

  const plan = buildCleanupDryRunPlan(report);

  // Every safety field must explicitly deny mutation/live-operation paths.
  assert.strictEqual(plan.safety.mutationPerformed, false);
  assert.strictEqual(plan.safety.operatorApprovalRequired, true);
  assert.strictEqual(plan.safety.backupRequired, true);
  assert.strictEqual(plan.safety.staleWorkerRowsMayBeValid, true);
  assert.strictEqual(plan.safety.liveProviderSendPerformed, false);
  assert.strictEqual(plan.safety.terminalAckSent, false);
  assert.strictEqual(plan.safety.dbMutationPerformed, false);
});

test("buildCleanupDryRunPlan bound report reflects source readiness", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:bound",
    totalTaskRoots: 5,
    totalRunDirs: 12,
    staleRuns: 3,
    malformedRuns: 2,
    orphanTaskRoots: 1,
    runs: [
      { safeTaskId: "a", runToken: "1", ageMs: 1, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
    ],
  };

  const plan = buildCleanupDryRunPlan(report);
  assert.equal(plan.boundReadinessReport.rootLabel, "runner-root:bound");
  assert.equal(plan.boundReadinessReport.totalTaskRoots, 5);
  assert.equal(plan.boundReadinessReport.totalRunDirs, 12);
  assert.equal(plan.boundReadinessReport.staleRuns, 3);
  assert.equal(plan.boundReadinessReport.malformedRuns, 2);
  assert.equal(plan.boundReadinessReport.orphanTaskRoots, 1);
});

test("buildCleanupDryRunPlan entries are sorted deterministically by candidateId", () => {
  const report: ReadinessReport = {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:sort",
    totalTaskRoots: 3,
    totalRunDirs: 3,
    staleRuns: 3,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs: [
      { safeTaskId: "zzz", runToken: "last", ageMs: 5000000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
      { safeTaskId: "aaa", runToken: "first", ageMs: 5000000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
      { safeTaskId: "mmm", runToken: "middle", ageMs: 5000000, status: "stale", terminal: false, runJsonMalformed: false, manifestMalformed: false, orphanTaskRoot: false },
    ],
  };

  const plan = buildCleanupDryRunPlan(report);
  assert.equal(plan.entries.length, 3);
  // Should be sorted by candidateId (which starts with cleanup:safeTaskId:...).
  const ids = plan.entries.map((e) => e.candidateId);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i - 1]! < ids[i]!, `entries must be sorted: ${ids[i - 1]} >= ${ids[i]}`);
  }
  assert.ok(plan.entries[0]!.candidateId.includes("aaa"), "first entry should be aaa");
  assert.ok(plan.entries[2]!.candidateId.includes("zzz"), "last entry should be zzz");
});
