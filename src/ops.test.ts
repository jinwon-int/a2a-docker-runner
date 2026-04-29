import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, install } from "./ops.js";
import type { RunnerConfig } from "./types.js";

function config(rootDir: string, githubTokenFile?: string): RunnerConfig {
  return { rootDir, engine: "docker", image: "example:latest", githubTokenFile, defaultTimeoutMs: 1000 };
}

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

test("cleanup dry-run reports expired task dirs without deleting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const oldTask = join(root, "old-task");
  const newTask = join(root, "new-task");
  await mkdir(oldTask);
  await mkdir(newTask);
  const now = Date.now();
  await utimes(oldTask, new Date(now - 10_000), new Date(now - 10_000));

  const report = await cleanup({ rootDir: root, ttlMs: 5_000, dryRun: true, nowMs: now });

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.candidates, [oldTask]);
  assert.equal((await stat(oldTask)).isDirectory(), true);
  assert.equal((await stat(newTask)).isDirectory(), true);
});

test("cleanup removes only directories older than TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cleanup-"));
  const oldTask = join(root, "old-task");
  const newTask = join(root, "new-task");
  const marker = join(root, "README.txt");
  await mkdir(oldTask);
  await mkdir(newTask);
  await writeFile(marker, "not a task directory");
  const now = Date.now();
  await utimes(oldTask, new Date(now - 10_000), new Date(now - 10_000));

  const report = await cleanup({ rootDir: root, ttlMs: 5_000, nowMs: now });

  assert.deepEqual(report.removed, [oldTask]);
  await assert.rejects(stat(oldTask));
  assert.equal((await stat(newTask)).isDirectory(), true);
  assert.equal((await stat(marker)).isFile(), true);
});
