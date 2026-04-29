import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunArgs, redactSecrets, runTask } from "./runner.js";
import type { RunnerConfig, RunnerTask } from "./types.js";

const config: RunnerConfig = {
  rootDir: join(tmpdir(), "a2a-runner-contract"),
  engine: "docker",
  image: "example/image:ci",
  githubTokenFile: "/tmp/hosts.yml",
  defaultTimeoutMs: 1000,
  memory: "256m",
  cpus: "0.5",
};

const task: RunnerTask = {
  id: "contract/test 1",
  intent: "propose_patch",
  env: {
    SAFE_VALUE: "ok",
    GH_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  },
  commands: ["printf ok"],
};

test("builds a Docker/Podman-compatible invocation contract without requiring an engine", () => {
  const args = buildRunArgs(config, task, "/tmp/a2a-work");

  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  assert.ok(args.includes("--name"));
  assert.ok(args.includes("a2a-contract_test_1"));
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("bridge"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("256m"));
  assert.ok(args.includes("--cpus"));
  assert.ok(args.includes("0.5"));
  assert.ok(args.includes("/tmp/a2a-work:/work"));
  assert.ok(args.includes("/tmp/hosts.yml:/run/secrets/gh-hosts.yml:ro"));
  assert.ok(args.includes("GH_CONFIG_HOSTS=/run/secrets/gh-hosts.yml"));
  assert.ok(args.includes("SAFE_VALUE=ok"));
  assert.ok(args.includes("GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890"));
  assert.deepEqual(args.slice(-3), ["example/image:ci", "bash", "/work/run.sh"]);
});

test("redacts tokens from stdout/stderr style diagnostics", () => {
  const raw = [
    "url=https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz1234567890@github.com/jinon86/repo.git",
    "oauth_token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890",
    "password=supersensitive",
    "api_key=abc123",
  ].join("\n");
  const redacted = redactSecrets(raw);

  assert.doesNotMatch(redacted, /ghp_[A-Za-z0-9_]+/);
  assert.doesNotMatch(redacted, /github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(redacted, /supersensitive/);
  assert.doesNotMatch(redacted, /api_key=abc123/);
  assert.match(redacted, /<redacted/);
});

test("missing engine failure is actionable and CI-safe", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "a2a-missing-engine-"));
  const result = await runTask(
    {
      rootDir,
      engine: "definitely-missing-engine" as RunnerConfig["engine"],
      image: "missing/image:latest",
      defaultTimeoutMs: 1000,
    },
    { id: "missing-engine", intent: "propose_patch", commands: ["printf ok"] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /실행 파일을 찾을 수 없습니다|Docker 또는 Podman/);
});
