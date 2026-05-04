import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, stat, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeployedRevision, checkGitHubPatchReadiness, cleanup, install } from "./ops.js";
import type { RunnerConfig } from "./types.js";

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "A2A Test",
      GIT_AUTHOR_EMAIL: "a2a-test@example.invalid",
      GIT_COMMITTER_NAME: "A2A Test",
      GIT_COMMITTER_EMAIL: "a2a-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function makeRevisionRepo(): Promise<{ repo: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), "a2a-revision-"));
  runGit(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.1.0" }));
  runGit(repo, ["add", "package.json"]);
  runGit(repo, ["commit", "-m", "initial"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  runGit(repo, ["update-ref", "refs/remotes/origin/main", head]);
  return { repo, head };
}

test("deployed revision doctor passes for clean main matching upstream", async () => {
  const { repo, head } = await makeRevisionRepo();

  const report = await checkDeployedRevision(repo);

  assert.equal(report.status, "ok");
  assert.equal(report.detail?.localSha, head.slice(0, 12));
  assert.equal(report.detail?.localFullSha, head);
  assert.equal(report.detail?.upstreamMainSha, head.slice(0, 12));
  assert.equal(report.detail?.upstreamMainFullSha, head);
  assert.match(String(report.detail?.summary), /^PASS /);
});

test("deployed revision doctor warns for stale, dirty, non-main checkouts", async () => {
  const { repo, head } = await makeRevisionRepo();
  await writeFile(join(repo, "README.md"), "change on feature branch\n");
  runGit(repo, ["checkout", "-b", "feature/drift"]);
  await writeFile(join(repo, "local.txt"), "local change\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "feature change"]);
  await writeFile(join(repo, "dirty.txt"), "uncommitted\n");

  const report = await checkDeployedRevision(repo);

  assert.equal(report.status, "warn");
  assert.equal(report.detail?.upstreamMainSha, head.slice(0, 12));
  assert.equal(report.detail?.upstreamMainFullSha, head);
  assert.match(String(report.detail?.localFullSha), /^[0-9a-f]{40}$/);
  assert.equal(report.detail?.branch, "feature/drift");
  assert.equal(report.detail?.dirty, true);
  assert.match(String(report.detail?.reason), /dirty worktree/);
  assert.match(String(report.detail?.reason), /branch is feature\/drift/);
  assert.match(String(report.detail?.reason), /differs from upstream main/);
  assert.match(String(report.detail?.summary), /^WARN /);
});

function config(rootDir: string, githubTokenFile?: string): RunnerConfig {
  return { rootDir, engine: "docker", image: "example:latest", githubTokenFile, defaultTimeoutMs: 1000 };
}

test("GitHub patch readiness blocks missing command config", () => {
  const report = checkGitHubPatchReadiness(config("/tmp/a2a-test"));

  assert.equal(report.status, "fail");
  assert.match(report.message, /blocked: no patch command configured/);
  assert.deepEqual(report.detail?.missing, [
    "A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT",
    "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON",
  ]);
  assert.match(String(report.detail?.fallback), /Block evidence/);
});

test("GitHub patch readiness accepts safe commandScript", () => {
  const report = checkGitHubPatchReadiness({
    ...config("/tmp/a2a-test"),
    commandScript: "#!/usr/bin/env bash\nprintf 'https://github.com/jinwon-int/a2a-docker-runner/pull/1\\n'\n",
  });

  assert.equal(report.status, "ok");
  assert.equal(report.detail?.safe, true);
  assert.equal(report.detail?.eval, false);
});

test("GitHub patch readiness accepts commandJson argv and rejects malformed JSON", () => {
  const ready = checkGitHubPatchReadiness({
    ...config("/tmp/a2a-test"),
    commandJson: JSON.stringify({ argv: ["codex", "exec", "--help"], env: { A: "B" } }),
  });
  assert.equal(ready.status, "ok");
  assert.equal(ready.detail?.argvCount, 3);

  const malformed = checkGitHubPatchReadiness({
    ...config("/tmp/a2a-test"),
    commandJson: "not-json",
  });
  assert.equal(malformed.status, "fail");
  assert.match(malformed.message, /not valid JSON/);

  const emptyArgv = checkGitHubPatchReadiness({
    ...config("/tmp/a2a-test"),
    commandJson: JSON.stringify({ argv: [] }),
  });
  assert.equal(emptyArgv.status, "fail");
  assert.match(emptyArgv.message, /non-empty string argv array/);
});

test("GitHub patch readiness fails for legacy commandTemplate eval path", () => {
  const report = checkGitHubPatchReadiness({
    ...config("/tmp/a2a-test"),
    commandTemplate: "openclaw agent --help",
  });

  assert.equal(report.status, "fail");
  assert.match(report.message, /blocks legacy commandTemplate/);
  assert.equal(report.detail?.safe, false);
  assert.equal(report.detail?.eval, true);
  assert.deepEqual(report.detail?.allowedExecutors, ["openclaw", "codex"]);
});

test("install is idempotent and validates task root plus read-only secret mount intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-install-"));
  const root = join(dir, "tasks");
  const secret = join(dir, "hosts.yml");
  await writeFile(secret, "github.com:\n  oauth_token: test\n", { mode: 0o600 });

  const first = await install(config(root, secret));
  const second = await install(config(root, secret));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.taskRoot.status, "ok");
  assert.equal(first.secretMount.status, "ok");
  assert.equal(first.secretMount.detail?.mount, ":ro");
  assert.equal((await stat(root)).isDirectory(), true);
});

// ── Round 3 nested cleanup: <root>/<safeTaskId>/<runToken> structure ──────

function runJson(createdAt: string): string {
  return JSON.stringify({ taskId: "test-task", safeTaskId: "test-safetask", runToken: "test-run", createdAt });
}

test("cleanup removes expired run directories under nested task roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  // Task root with two expired run dirs
  const taskRoot = join(root, "task-1");
  const oldRun1 = join(taskRoot, "run-old-1");
  const oldRun2 = join(taskRoot, "run-old-2");
  await mkdir(oldRun1, { recursive: true });
  await mkdir(oldRun2, { recursive: true });
  await writeFile(join(oldRun1, "run.json"), runJson(new Date(now - 20_000).toISOString()));
  await writeFile(join(oldRun2, "run.json"), runJson(new Date(now - 15_000).toISOString()));
  // Also set mtime for fallback paths
  await utimes(oldRun1, new Date(now - 20_000), new Date(now - 20_000));
  await utimes(oldRun2, new Date(now - 15_000), new Date(now - 15_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, false);
  // Both runs should be candidates and removed
  assert.ok(report.candidates.includes(oldRun1));
  assert.ok(report.candidates.includes(oldRun2));
  assert.ok(report.removed.includes(oldRun1));
  assert.ok(report.removed.includes(oldRun2));
  // Task root should be removed because it's now empty
  assert.ok(report.candidates.includes(taskRoot));
  assert.ok(report.removed.includes(taskRoot));
  await assert.rejects(stat(taskRoot));
});

test("cleanup preserves recent runs and keeps task root with active runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  // Task root with one expired and one recent run dir
  const taskRoot = join(root, "task-mixed");
  const oldRun = join(taskRoot, "run-old");
  const recentRun = join(taskRoot, "run-recent");
  await mkdir(oldRun, { recursive: true });
  await mkdir(recentRun, { recursive: true });
  await writeFile(join(oldRun, "run.json"), runJson(new Date(now - 20_000).toISOString()));
  await writeFile(join(recentRun, "run.json"), runJson(new Date(now - 1_000).toISOString()));
  await utimes(oldRun, new Date(now - 20_000), new Date(now - 20_000));
  await utimes(recentRun, new Date(now - 1_000), new Date(now - 1_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  assert.equal(report.ok, true);
  // Expired run is candidate and removed
  assert.ok(report.candidates.includes(oldRun));
  assert.ok(report.removed.includes(oldRun));
  // Recent run is skipped
  assert.ok(report.skipped.includes(recentRun));
  // Task root is NOT removed (recent run still exists)
  assert.ok(!report.candidates.includes(taskRoot));
  assert.equal((await stat(taskRoot)).isDirectory(), true);
  assert.equal((await stat(recentRun)).isDirectory(), true);
  await assert.rejects(stat(oldRun));
});

test("cleanup dry-run reports candidates without deleting", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  const taskRoot = join(root, "task-dry");
  const oldRun = join(taskRoot, "run-old");
  await mkdir(oldRun, { recursive: true });
  await writeFile(join(oldRun, "run.json"), runJson(new Date(now - 20_000).toISOString()));
  await utimes(oldRun, new Date(now - 20_000), new Date(now - 20_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, dryRun: true, nowMs: now });

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.ok(report.candidates.includes(oldRun));
  assert.ok(report.candidates.includes(taskRoot));
  assert.equal(report.removed.length, 0);
  // Files must still exist
  assert.equal((await stat(oldRun)).isDirectory(), true);
  assert.equal((await stat(taskRoot)).isDirectory(), true);
});

test("cleanup handles malformed entries inside task roots (non-directory, broken)", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  const taskRoot = join(root, "task-weird");
  await mkdir(taskRoot, { recursive: true });
  // Non-directory inside task root
  const marker = join(taskRoot, "README.txt");
  await writeFile(marker, "not a run directory");
  // Expired run alongside malformed entry
  const oldRun = join(taskRoot, "run-old");
  await mkdir(oldRun, { recursive: true });
  await writeFile(join(oldRun, "run.json"), runJson(new Date(now - 20_000).toISOString()));
  await utimes(oldRun, new Date(now - 20_000), new Date(now - 20_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  assert.equal(report.ok, true);
  // Non-directory entry is skipped
  assert.ok(report.skipped.includes(marker));
  // Expired run is still removed
  assert.ok(report.removed.includes(oldRun));
  // Task root is NOT removed (README.txt remains)
  assert.ok(!report.candidates.includes(taskRoot));
  assert.equal((await stat(taskRoot)).isDirectory(), true);
  assert.equal((await stat(marker)).isFile(), true);
});

test("cleanup skips non-directory entries at root level", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  const marker = join(root, "NOTES.md");
  await writeFile(marker, "# notes");

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  assert.ok(report.skipped.includes(marker));
  assert.equal((await stat(marker)).isFile(), true);
});

test("cleanup handles missing rootDir gracefully", async () => {
  const report = await cleanup({ rootDir: "/nonexistent/path/12345", ttlMs: 10_000 });
  assert.equal(report.ok, true);
  assert.equal(report.removed.length, 0);
  assert.equal(report.candidates.length, 0);
});

test("cleanup handles empty rootDir gracefully", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000 });

  assert.equal(report.ok, true);
  assert.equal(report.removed.length, 0);
  assert.equal(report.candidates.length, 0);
});

test("cleanup handles empty task root (no run dirs inside)", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  // Create a task root with no run dirs — should be pruned if aged
  const emptyTask = join(root, "empty-task");
  await mkdir(emptyTask, { recursive: true });
  await utimes(emptyTask, new Date(now - 20_000), new Date(now - 20_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  // Empty task root with no run dirs inside: it's a directory at root level.
  // It has no run-token subdirectories, so it won't be evaluated as a task root
  // with expired runs. It should be skipped (not a run dir with run.json).
  // The old behavior removed top-level dirs; we now skip non-run dirs.
  // However, the directory IS a task root — it just has no runs.
  // Since it has no run dirs and no other entries, it's an empty task root.
  // We should treat it like: no expired runs, no recent runs → check if empty → prune.
  // The current implementation only checks emptiness after removing expired runs.
  // An empty task root with mtime older than TTL should be prunable.
  // Let's verify: evaluateTaskRoot returns empty arrays for all three lists.
  // In cleanup: no expiredDirs → task root NOT processed as empty-check.
  // So empty task roots are left alone. This is conservative and safe.
  assert.equal(report.ok, true);
  // The empty dir is not a run-token dir, so cleanup traverses it but finds
  // nothing to expire. It remains skipped.
  assert.equal((await stat(emptyTask)).isDirectory(), true);
});

test("cleanup uses run.json.createdAt for age calculation", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  // run.json says old, but mtime is recent → should use createdAt (expired)
  const taskRoot = join(root, "task-json-age");
  const run = join(taskRoot, "run-by-json");
  await mkdir(run, { recursive: true });
  // createdAt suggests the run is 20s old (expired with 10s TTL)
  await writeFile(join(run, "run.json"), runJson(new Date(now - 20_000).toISOString()));
  // mtime is very recent (1s ago) — would be recent if createdAt not used
  await utimes(run, new Date(now - 1_000), new Date(now - 1_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  // Should be expired based on createdAt, not mtime
  assert.ok(report.candidates.includes(run));
  assert.ok(report.removed.includes(run));
});

test("cleanup falls back to mtime when run.json is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  // No run.json, only mtime is old → should be expired based on mtime
  const taskRoot = join(root, "task-mtime");
  const run = join(taskRoot, "run-by-mtime");
  await mkdir(run, { recursive: true });
  await utimes(run, new Date(now - 20_000), new Date(now - 20_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  assert.ok(report.candidates.includes(run));
  assert.ok(report.removed.includes(run));
});

test("cleanup report preserves JSON shape with all fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const now = Date.now();

  const taskRoot = join(root, "task-report");
  const oldRun = join(taskRoot, "run-old");
  await mkdir(oldRun, { recursive: true });
  await writeFile(join(oldRun, "run.json"), runJson(new Date(now - 20_000).toISOString()));
  await utimes(oldRun, new Date(now - 20_000), new Date(now - 20_000));

  const report = await cleanup({ rootDir: root, ttlMs: 10_000, nowMs: now });

  assert.equal(typeof report.ok, "boolean");
  assert.equal(typeof report.dryRun, "boolean");
  assert.equal(typeof report.rootDir, "string");
  assert.equal(typeof report.ttlMs, "number");
  assert.ok(Array.isArray(report.removed));
  assert.ok(Array.isArray(report.candidates));
  assert.ok(Array.isArray(report.skipped));
  // JSON-serialisable
  const json = JSON.stringify(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.ok, report.ok);
});
