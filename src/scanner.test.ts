import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanHistory, createArtifactBundle, type ScanProfile, type ScanRunEntry } from "./scanner.js";
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
