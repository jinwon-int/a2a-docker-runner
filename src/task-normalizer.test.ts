import assert from "node:assert/strict";
import test from "node:test";
import { defaultCheckoutPath, isPatchMode, normalizeRepoUrl, normalizeTask } from "./task-normalizer.js";

test("normalizes GitHub shorthand repo URLs", () => {
  assert.equal(normalizeRepoUrl("jinwon-int/openclaw-plugin-a2a"), "https://github.com/jinwon-int/openclaw-plugin-a2a.git");
  assert.equal(normalizeRepoUrl("https://github.com/jinwon-int/openclaw-plugin-a2a.git"), "https://github.com/jinwon-int/openclaw-plugin-a2a.git");
});

test("derives stable checkout paths", () => {
  assert.equal(defaultCheckoutPath("https://github.com/jinwon-int/openclaw-plugin-a2a.git"), "openclaw-plugin-a2a");
  assert.equal(defaultCheckoutPath("jinwon-int/openclaw-plugin-a2a"), "openclaw-plugin-a2a");
});

test("expands openclaw-plugin-a2a preset into repo checkout and test commands", () => {
  const task = normalizeTask({
    id: "plugin-dev",
    intent: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
  });

  assert.deepEqual(task.repos, [{
    name: "openclaw-plugin-a2a",
    url: "https://github.com/jinwon-int/openclaw-plugin-a2a.git",
    branch: "main",
    path: "openclaw-plugin-a2a",
    primary: true,
  }]);
  assert.deepEqual(task.commands, [
    "cd /work/openclaw-plugin-a2a && npm ci",
    "cd /work/openclaw-plugin-a2a && npm test",
  ]);
});

test("keeps explicit multi-repo and command configuration", () => {
  const task = normalizeTask({
    id: "integration-dev",
    intent: "propose_patch",
    repos: [
      { name: "plugin", url: "jinwon-int/openclaw-plugin-a2a", path: "plugin", primary: true },
      { name: "core", url: "jinon86/openclaw", path: "openclaw", branch: "develop" },
    ],
    commands: ["cd /work/plugin && npm ci", "cd /work/plugin && npm test"],
  });

  assert.equal(task.repos.length, 2);
  assert.equal(task.repos[0]?.url, "https://github.com/jinwon-int/openclaw-plugin-a2a.git");
  assert.equal(task.repos[0]?.path, "plugin");
  assert.equal(task.repos[1]?.branch, "develop");
  assert.deepEqual(task.commands, ["cd /work/plugin && npm ci", "cd /work/plugin && npm test"]);
});

test("passes through mode, issueUrl, reportLanguage, and requestedBy", () => {
  const task = normalizeTask({
    id: "github-evidence-task",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    issueUrl: "https://github.com/jinon86/test-repo/issues/5",
    reportLanguage: "ko",
    requestedBy: "seoseo",
  });

  assert.equal(task.mode, "github-propose-patch");
  assert.equal(task.issueUrl, "https://github.com/jinon86/test-repo/issues/5");
  assert.equal(task.reportLanguage, "ko");
  assert.equal(task.requestedBy, "seoseo");
  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.url, "https://github.com/jinon86/test-repo.git");
  assert.ok(task.commands.length > 0);
});

// ---------------------------------------------------------------------------
// isPatchMode
// ---------------------------------------------------------------------------

test("isPatchMode recognises github-propose-patch and propose_patch", () => {
  assert.equal(isPatchMode("github-propose-patch"), true);
  assert.equal(isPatchMode("propose_patch"), true);
  assert.equal(isPatchMode("chat"), false);
  assert.equal(isPatchMode(undefined), false);
  assert.equal(isPatchMode(""), false);
});

// ---------------------------------------------------------------------------
// default command generation for github-propose-patch / propose_patch
// ---------------------------------------------------------------------------

test("generates PR-producing default commands for github-propose-patch mode without explicit commands", () => {
  const task = normalizeTask({
    id: "auto-patch-test",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    prompt: "Fix the broken test.",
    issueUrl: "https://github.com/jinon86/test-repo/issues/5",
    requestedBy: "seoseo",
  });

  // Must generate commands (not use explicit ones).
  assert.ok(task.commands.length > 0, "Expected default commands");

  // Step 1: prompt artifact writing.
  const writeCmd = task.commands[0] ?? "";
  assert.ok(writeCmd.includes("/work/artifacts/prompt.md"), "Expected prompt artifact write");
  assert.ok(writeCmd.includes("Fix the broken test."), "Expected prompt content in command");
  assert.ok(writeCmd.includes("patch_mode=github-propose-patch"), "Expected patch mode marker");

  // Step 2: PR-producing pipeline.
  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("git checkout -b"), "Expected branch creation");
  assert.ok(pipeline.includes("git commit -m"), "Expected commit step");
  assert.ok(pipeline.includes("git push origin"), "Expected push step");
  assert.ok(pipeline.includes("gh pr create"), "Expected PR create step");
  assert.ok(pipeline.includes("patch-command.sh"), "Expected script file reference");
  assert.ok(pipeline.includes("patch_mode=script"), "Expected script mode marker");
  assert.ok(pipeline.includes("A2A_PATCH_COMMAND"), "Expected legacy escape hatch reference");
  assert.ok(pipeline.includes("no_patch_command_configured"), "Expected no-op fallback");
  assert.ok(pipeline.includes("deprecated_eval_path"), "Expected deprecation warning");
  assert.ok(pipeline.includes("/work/artifacts/patch-command.log"), "Expected coding agent log artifact");
  assert.ok(pipeline.includes("/work/artifacts/pr-output.txt"), "Expected PR output artifact");
  assert.ok(pipeline.includes("status=no_changes"), "Expected no-changes fallback");
});

test("generates PR-producing default commands for propose_patch mode", () => {
  const task = normalizeTask({
    id: "legacy-patch-mode",
    intent: "propose_patch",
    mode: "propose_patch",
    repo: "jinon86/test-repo",
    baseBranch: "develop",
    prompt: "Update README.",
    requestedBy: "dungae",
  });

  assert.ok(task.commands.length > 0);
  // verify baseBranch is honoured.
  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes('--base "develop"'), "Expected base branch develop in PR create");
});

test("does not override explicit commands even in github-propose-patch mode", () => {
  const explicit = ["cd /work/repo && npm ci", "cd /work/repo && npm test"];
  const task = normalizeTask({
    id: "explicit-cmds",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    commands: explicit,
    prompt: "This prompt should not appear in commands.",
  });

  assert.deepEqual(task.commands, explicit);
});

test("handles patch mode with no prompt gracefully", () => {
  const task = normalizeTask({
    id: "no-prompt-patch",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
  });

  assert.ok(task.commands.length > 0);
  const writeCmd = task.commands[0] ?? "";
  // Should have a fallback prompt.
  assert.ok(writeCmd.includes("/work/artifacts/prompt.md"), "Expected prompt artifact even without prompt");
});

test("sanitises task id in branch name", () => {
  const task = normalizeTask({
    id: "spaces and/slashes:unsafe",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    prompt: "Test.",
  });

  const pipeline = task.commands[1] ?? "";
  // Branch name should NOT contain spaces, slashes, or colons.
  assert.ok(!pipeline.includes("a2a-patch-" + "spaces and"), "Spaces should be sanitised");
  assert.ok(pipeline.includes("spaces_" + "and_slashes_unsafe"),
    `Expected sanitised id in branch, got snippet: ${pipeline.slice(pipeline.indexOf("BRANCH="), pipeline.indexOf("BRANCH=") + 80)}`);
});
