import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTask, normalizeRepoUrl, defaultCheckoutPath, isPatchMode } from "./task-normalizer.js";

// ---------------------------------------------------------------------------
// Monorepo build/test topology & template migration proof — issue #262
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Multi-repo (workspace-like) task normalization
// ---------------------------------------------------------------------------

test("normalizes a monorepo-style multi-repo task with primary and secondary repos", () => {
  const task = normalizeTask({
    id: "monorepo-integration",
    intent: "propose_patch",
    repos: [
      { name: "runner", url: "jinwon-int/a2a-docker-runner", path: "runner", primary: true },
      { name: "broker", url: "jinwon-int/a2a-broker", path: "broker" },
    ],
    commands: [
      "cd /work/runner && npm ci && npm test",
      "cd /work/broker && npm ci && npm test",
    ],
  });

  assert.equal(task.repos.length, 2);
  assert.equal(task.repos[0]?.path, "runner");
  assert.equal(task.repos[0]?.primary, true);
  assert.equal(task.repos[1]?.path, "broker");
  assert.equal(task.repos[1]?.primary, false);
  assert.deepEqual(task.commands, [
    "cd /work/runner && npm ci && npm test",
    "cd /work/broker && npm ci && npm test",
  ]);
});

test("normalizes a monorepo migration task with readOnlyValidation for CI-safe proof", () => {
  const task = normalizeTask({
    id: "monorepo-proof-migration",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
    baseBranch: "main",
    readOnlyValidation: true,
    commands: [
      "cd /work/repo && npm run check",
      "cd /work/repo && npm run build",
      "cd /work/repo && npm test",
    ],
  });

  assert.equal(task.allowNoChanges, true, "readOnlyValidation implies allowNoChanges");
  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.path, "repo");
  assert.equal(task.repos[0]?.url, "https://github.com/jinwon-int/a2a-docker-runner.git");
});

// ---------------------------------------------------------------------------
// 2. Workspace package checkout path derivation
// ---------------------------------------------------------------------------

test("defaultCheckoutPath works for known and non-standard repo URLs", () => {
  assert.equal(defaultCheckoutPath("https://github.com/jinwon-int/a2a-docker-runner.git"), "a2a-docker-runner");
  assert.equal(defaultCheckoutPath("jinwon-int/a2a-docker-runner"), "a2a-docker-runner");
  assert.equal(defaultCheckoutPath("https://github.com/jinwon-int/openclaw-plugin-a2a"), "openclaw-plugin-a2a");
  assert.equal(defaultCheckoutPath("jinwon-int/monorepo-workspace"), "monorepo-workspace");
  // With branch reference in URL (not a real git URL pattern but safe)
  assert.equal(defaultCheckoutPath("jinwon-int/some-tools"), "some-tools");
});

test("normalizeRepoUrl preserves explicit full URLs and expands shorthand", () => {
  assert.equal(normalizeRepoUrl("jinwon-int/monorepo"), "https://github.com/jinwon-int/monorepo.git");
  assert.equal(normalizeRepoUrl("jinwon-int/a2a-docker-runner"), "https://github.com/jinwon-int/a2a-docker-runner.git");
  assert.equal(
    normalizeRepoUrl("https://github.com/jinwon-int/a2a-docker-runner.git"),
    "https://github.com/jinwon-int/a2a-docker-runner.git",
  );
  // Full URLs without .git suffix are returned as-is (the normalization
  // only adds .git for shorthand patterns, not for explicit full URLs).
  assert.equal(
    normalizeRepoUrl("https://github.com/jinwon-int/a2a-docker-runner"),
    "https://github.com/jinwon-int/a2a-docker-runner",
  );
});

// ---------------------------------------------------------------------------
// 3. Template migration mode recognition
// ---------------------------------------------------------------------------

test("isPatchMode recognizes all patch modes relevant to monorepo migration", () => {
  assert.equal(isPatchMode("github-propose-patch"), true);
  assert.equal(isPatchMode("propose_patch"), true);
  assert.equal(isPatchMode("github-verify"), true);
  assert.equal(isPatchMode("migrate"), false, "migrate is not a built-in patch mode");
  assert.equal(isPatchMode("monorepo"), false, "monorepo is not a built-in patch mode");
  assert.equal(isPatchMode(undefined), false);
});

// ---------------------------------------------------------------------------
// 4. Preset scope in monorepo context
// ---------------------------------------------------------------------------

test("openclaw-plugin-a2a-dev preset generates test commands for single-checkout monorepo packages", () => {
  const task = normalizeTask({
    id: "plugin-monorepo",
    intent: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
    baseBranch: "develop",
  });

  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.branch, "develop");
  assert.equal(task.repos[0]?.path, "openclaw-plugin-a2a");
  assert.equal(task.repos[0]?.url, "https://github.com/jinwon-int/openclaw-plugin-a2a.git");

  // Preset commands: npm ci + npm test
  assert.deepEqual(task.commands, [
    "cd /work/openclaw-plugin-a2a && npm ci",
    "cd /work/openclaw-plugin-a2a && npm test",
  ]);
});

test("explicit commands override preset-generated commands for workspace-aware testing", () => {
  const task = normalizeTask({
    id: "monorepo-workspace-test",
    intent: "propose_patch",
    repos: [
      { url: "jinwon-int/a2a-monorepo", path: "a2a-monorepo", primary: true },
    ],
    commands: [
      "cd /work/a2a-monorepo && npm ci",
      "cd /work/a2a-monorepo && npm test -- --workspaces",
      "cd /work/a2a-monorepo && npm run build --workspace packages/cli",
    ],
  });

  assert.deepEqual(task.commands, [
    "cd /work/a2a-monorepo && npm ci",
    "cd /work/a2a-monorepo && npm test -- --workspaces",
    "cd /work/a2a-monorepo && npm run build --workspace packages/cli",
  ]);
  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.path, "a2a-monorepo");
});

// ---------------------------------------------------------------------------
// 5. allowNoChanges / readOnlyValidation interaction for migration proof tasks
// ---------------------------------------------------------------------------

test("allowNoChanges=true is preserved through normalization for evidence-only lanes", () => {
  const task = normalizeTask({
    id: "migration-evidence-only",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
    allowNoChanges: true,
    commands: ["cd /work/repo && npm test"],
  });

  assert.equal(task.allowNoChanges, true);
});

test("readOnlyValidation sets allowNoChanges for migration cross-check tasks", () => {
  const task = normalizeTask({
    id: "migration-cross-check",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
    readOnlyValidation: true,
    commands: ["cd /work/repo && npm run check"],
  });

  assert.equal(task.allowNoChanges, true);
  assert.equal(task.readOnlyValidation, true);
});

// ---------------------------------------------------------------------------
// 6. Error handling: missing repo in monorepo multi-repo tasks
// ---------------------------------------------------------------------------

test("task with single repo field and no repos array creates one repo entry", () => {
  const task = normalizeTask({
    id: "single-repo",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
  });

  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.path, "repo");
  assert.equal(task.repos[0]?.primary, true);
});

test("task without repo or repos uses preset derivation", () => {
  const task = normalizeTask({
    id: "preset-only",
    intent: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
  });

  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.path, "openclaw-plugin-a2a");
  assert.equal(task.repos[0]?.url, "https://github.com/jinwon-int/openclaw-plugin-a2a.git");
});

// ---------------------------------------------------------------------------
// 7. artifact path invariants (string-based, no filesystem access)
// ---------------------------------------------------------------------------

test("default patch commands reference /work/artifacts/ consistently", () => {
  const task = normalizeTask({
    id: "artifact-path-test",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/a2a-docker-runner",
    issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/1",
  });

  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.path, "repo");

  // All default commands for patch mode should reference /work/artifacts/ directory
  const commandsText = task.commands.join("\n");
  const artifactRefs = (commandsText.match(/\/work\/artifacts\//g) || []).length;
  assert.ok(artifactRefs > 0, "default patch commands must reference /work/artifacts/");

  // Verify the pipeline starts with cd to the repo path
  assert.ok(commandsText.includes("cd /work/repo"), "pipeline should cd to /work/repo");
});

// ---------------------------------------------------------------------------
// 8. Migration state — template compatibility patterns
// ---------------------------------------------------------------------------

test("github-verify mode is recognised alongside propose_patch for monorepo CI verification", () => {
  assert.equal(isPatchMode("github-verify"), true);
});

test("normalizeTask preserves explicit commands for github-verify mode", () => {
  const task = normalizeTask({
    id: "monorepo-ci-verify",
    intent: "propose_patch",
    mode: "github-verify",
    repo: "jinwon-int/a2a-docker-runner",
    commands: [
      "cd /work/repo && npm run check",
      "cd /work/repo && npm run build",
      "cd /work/repo && npm test",
    ],
  });

  assert.equal(task.mode, "github-verify");
  assert.equal(task.repos.length, 1);
  assert.deepEqual(task.commands, [
    "cd /work/repo && npm run check",
    "cd /work/repo && npm run build",
    "cd /work/repo && npm test",
  ]);
});

// ---------------------------------------------------------------------------
// 9. Template: extra domain normalization (Docker image, env passthrough)
// ---------------------------------------------------------------------------

test("task-level env passthrough does not conflict with repo normalization", () => {
  const task = normalizeTask({
    id: "env-test",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-docker-runner",
    env: {
      A2A_DOCKER_RUNNER_IMAGE: "node:22-bookworm-slim",
      A2A_DOCKER_RUNNER_TIMEOUT_MS: "300000",
    },
  });

  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.url, "https://github.com/jinwon-int/a2a-docker-runner.git");
  assert.equal(task.env?.A2A_DOCKER_RUNNER_IMAGE, "node:22-bookworm-slim");
});

test("timeoutMs is preserved across normalization for long-running monorepo build tasks", () => {
  const task = normalizeTask({
    id: "monorepo-build",
    intent: "propose_patch",
    repo: "jinwon-int/a2a-monorepo",
    timeoutMs: 1800000, // 30 minutes for full workspace build
  });

  assert.equal(task.timeoutMs, 1800000);
  assert.equal(task.repos.length, 1);
});
