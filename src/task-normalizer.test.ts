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
      { name: "core", url: "jinwon-int/openclaw", path: "openclaw", branch: "develop" },
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
    repo: "jinwon-int/test-repo",
    issueUrl: "https://github.com/jinwon-int/test-repo/issues/5",
    reportLanguage: "ko",
    requestedBy: "seoseo",
  });

  assert.equal(task.mode, "github-propose-patch");
  assert.equal(task.issueUrl, "https://github.com/jinwon-int/test-repo/issues/5");
  assert.equal(task.reportLanguage, "ko");
  assert.equal(task.requestedBy, "seoseo");
  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.url, "https://github.com/jinwon-int/test-repo.git");
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
    repo: "jinwon-int/test-repo",
    baseBranch: "main",
    prompt: "Fix the broken test.",
    issueUrl: "https://github.com/jinwon-int/test-repo/issues/5",
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
  assert.ok(pipeline.includes("--body-file /work/artifacts/pr-body.md"), "Expected PR body file use");
  assert.ok(pipeline.includes("Closes #5"), "Expected same-repo closing keyword in PR body");
  assert.ok(pipeline.includes("printf 'Start\\n' > /work/artifacts/issue-start-comment.md"), "Expected literal Start issue comment body");
  assert.ok(pipeline.includes("/work/artifacts/issue-start-comment.md"), "Expected start comment artifact");
  assert.ok(pipeline.indexOf("issue-start-comment.md") < pipeline.indexOf("patch-command.sh"), "Expected start comment before patch execution");
  assert.ok(pipeline.includes("error=gh_unavailable_start_comment_required"), "Expected gh-missing start comment to fail closed");
  assert.ok(pipeline.includes("error=start_comment_failed"), "Expected failed start comment to fail closed");
  assert.ok(pipeline.includes("start_comment=posted"), "Expected posted start comment evidence marker");
  assert.ok(pipeline.includes("gh issue comment 'https://github.com/jinwon-int/test-repo/issues/5'"), "Expected issue PR comment");
  assert.ok(pipeline.includes("/work/artifacts/issue-comment-output.txt"), "Expected issue comment output artifact");
  assert.ok(pipeline.includes("patch-command.sh"), "Expected script file reference");
  assert.ok(pipeline.includes("patch_mode=script"), "Expected script mode marker");
  assert.ok(pipeline.includes("A2A_PATCH_COMMAND"), "Expected legacy escape hatch reference");
  assert.ok(pipeline.includes("error=no_patch_command_configured"), "Expected blocked fallback");
  assert.ok(pipeline.includes("exit 2"), "Expected missing patch command to fail, not no-op succeed");
  assert.ok(pipeline.includes("A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT"), "Expected actionable commandScript env guidance");
  assert.ok(pipeline.includes("deprecated_eval_path"), "Expected deprecation warning");
  assert.ok(pipeline.includes("/work/artifacts/patch-command.log"), "Expected coding agent log artifact");
  assert.ok(pipeline.includes("/work/artifacts/pr-output.txt"), "Expected PR output artifact");
  assert.ok(pipeline.includes("a2a-gh-pr-update-branch \"$PR_URL\" \"main\""), "Expected post-create update-branch helper");
  assert.ok(pipeline.includes("/work/artifacts/pr-update-branch-output.txt"), "Expected update-branch output artifact");
  assert.ok(pipeline.includes("warning=pr_update_branch_failed"), "Expected non-fatal update-branch fallback marker");
  assert.ok(pipeline.includes("error=pr_create_failed_or_missing_url"), "Expected missing PR URL to fail safely");
  assert.ok(pipeline.includes("error=no_changes_after_patch_command"), "Expected no-changes fallback to fail safely");

  const generated = task.commands.join("\n");
  assert.doesNotMatch(generated, /claude-(install|output|prompt)|@anthropic-ai\/claude-code|claude --/i);
});

test("generates comment-only closeout commands without PR creation", () => {
  const task = normalizeTask({
    id: "closeout-only",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/test-repo",
    existingPrNumber: 42,
    commentOnly: true,
    forbidNewPr: true,
    prompt: "Close out the existing PR with evidence only.",
  });

  assert.equal(task.commands.length, 1);
  const command = task.commands[0] ?? "";
  assert.ok(command.includes("patch_mode=comment_only"), "Expected comment-only marker");
  assert.ok(command.includes("new_pr_allowed=0"), "Expected no-new-PR marker");
  assert.ok(command.includes("existing_pr=%s\\n' 'https://github.com/jinwon-int/test-repo/pull/42'"), "Expected derived existing PR URL");
  assert.ok(!command.includes("gh pr create"), "Must not create a duplicate PR");
  assert.ok(!command.includes("git push origin"), "Must not push a duplicate branch");
});

test("forbidNewPr blocks default patch pipeline before push or PR creation", () => {
  const task = normalizeTask({
    id: "no-duplicate-pr",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/test-repo",
    forbidNewPr: true,
  });

  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("error=new_pr_forbidden"), "Expected explicit block marker");
  assert.ok(!pipeline.includes("git push origin"), "Must not push a new branch when new PRs are forbidden");
  assert.ok(!pipeline.includes("gh pr create"), "Must not create a duplicate PR when forbidden");
});

test("generates PR-producing default commands for propose_patch mode", () => {
  const task = normalizeTask({
    id: "legacy-patch-mode",
    intent: "propose_patch",
    mode: "propose_patch",
    repo: "jinwon-int/test-repo",
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
    repo: "jinwon-int/test-repo",
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
    repo: "jinwon-int/test-repo",
    baseBranch: "main",
  });

  assert.ok(task.commands.length > 0);
  const writeCmd = task.commands[0] ?? "";
  // Should have a fallback prompt.
  assert.ok(writeCmd.includes("/work/artifacts/prompt.md"), "Expected prompt artifact even without prompt");
});

// Regression: openclaw-plugin-a2a issue #119 — preset was checked before
// isPatchMode, so preset+patch-mode tasks ran test-only commands instead of
// the PR-producing pipeline.
test("uses patch pipeline when openclaw-plugin-a2a-dev preset is combined with github-propose-patch mode", () => {
  const task = normalizeTask({
    id: "plugin-patch",
    intent: "propose_patch",
    mode: "github-propose-patch",
    preset: "openclaw-plugin-a2a-dev",
    baseBranch: "main",
    prompt: "Fix the plugin bug.",
    issueUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/119",
    requestedBy: "jinwon",
  });

  // Repo should still be expanded from the preset.
  assert.equal(task.repos.length, 1);
  assert.equal(task.repos[0]?.name, "openclaw-plugin-a2a");

  // Commands must be the PR-producing pipeline, NOT npm test.
  assert.ok(task.commands.length > 0, "Expected commands");
  const writeCmd = task.commands[0] ?? "";
  assert.ok(writeCmd.includes("/work/artifacts/prompt.md"), "Expected prompt artifact write");
  assert.ok(writeCmd.includes("patch_mode=github-propose-patch"), "Expected patch mode marker");

  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("git checkout -b"), "Expected branch creation");
  assert.ok(pipeline.includes("gh pr create"), "Expected PR create step");
  assert.ok(!pipeline.includes("npm test"), "Must NOT contain bare npm test — should be patch pipeline, not test preset");
});

test("uses patch pipeline when openclaw-plugin-a2a-dev preset is combined with propose_patch mode", () => {
  const task = normalizeTask({
    id: "plugin-patch-legacy",
    intent: "propose_patch",
    mode: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
    baseBranch: "main",
    prompt: "Update plugin.",
  });

  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("git checkout -b"), "Expected branch creation in patch pipeline");
  assert.ok(pipeline.includes("gh pr create"), "Expected PR create in patch pipeline");
});

test("openclaw-plugin-a2a-dev preset without patch mode still runs test commands", () => {
  const task = normalizeTask({
    id: "plugin-dev-test",
    intent: "smoke",
    preset: "openclaw-plugin-a2a-dev",
  });

  assert.deepEqual(task.commands, [
    "cd /work/openclaw-plugin-a2a && npm ci",
    "cd /work/openclaw-plugin-a2a && npm test",
  ]);
});

test("sanitises task id in branch name", () => {
  const task = normalizeTask({
    id: "spaces and/slashes:unsafe",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinwon-int/test-repo",
    baseBranch: "main",
    prompt: "Test.",
  });

  const pipeline = task.commands[1] ?? "";
  // Branch name should NOT contain spaces, slashes, or colons.
  assert.ok(!pipeline.includes("a2a-patch-" + "spaces and"), "Spaces should be sanitised");
  assert.ok(pipeline.includes("spaces_" + "and_slashes_unsafe"),
    `Expected sanitised id in branch, got snippet: ${pipeline.slice(pipeline.indexOf("BRANCH="), pipeline.indexOf("BRANCH=") + 80)}`);
});

// ---------------------------------------------------------------------------
// PR body files: content structure and closing keywords
// ---------------------------------------------------------------------------

function extractPrBodyFromPipeline(pipeline: string): string {
  const marker = "<<'A2A_PR_BODY_EOF'\n";
  const start = pipeline.indexOf(marker);
  if (start === -1) return "";
  const bodyStart = start + marker.length;
  const end = pipeline.indexOf("\nA2A_PR_BODY_EOF", bodyStart);
  if (end === -1) return "";
  return pipeline.slice(bodyStart, end);
}

test("cross-repo closing ref uses owner/repo#N format in PR body", () => {
  const task = normalizeTask({
    id: "cross-repo-issue",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/other-repo",
    baseBranch: "main",
    issueUrl: "https://github.com/jinon86/test-repo/issues/7",
  });

  const pipeline = task.commands[1] ?? "";
  const prBody = extractPrBodyFromPipeline(pipeline);
  assert.ok(prBody.includes("Closes jinon86/test-repo#7"), `Expected cross-repo closing ref, got: ${prBody}`);
  assert.ok(!prBody.includes("Closes #7"), "Should not use bare #N for cross-repo issue");
});

test("same-repo closing ref uses bare #N format in PR body", () => {
  const task = normalizeTask({
    id: "same-repo-issue",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    issueUrl: "https://github.com/jinon86/test-repo/issues/12",
  });

  const pipeline = task.commands[1] ?? "";
  const prBody = extractPrBodyFromPipeline(pipeline);
  assert.ok(prBody.includes("Closes #12"), "Expected bare #N closing ref for same-repo issue");
  assert.ok(!prBody.includes("Closes jinon86/test-repo#12"), "Should not use full org/repo#N for same-repo");
});

test("no Closes keyword in PR body when issueUrl is absent", () => {
  const task = normalizeTask({
    id: "no-issue-url",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    prompt: "Fix a bug.",
  });

  const pipeline = task.commands[1] ?? "";
  const prBody = extractPrBodyFromPipeline(pipeline);
  assert.ok(!prBody.includes("Closes"), `PR body should not have Closes when no issueUrl, got: ${prBody}`);
});

test("PR body contains issue URL and requestedBy when set", () => {
  const task = normalizeTask({
    id: "with-requester",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    requestedBy: "jinwon",
    issueUrl: "https://github.com/jinon86/test-repo/issues/3",
  });

  const pipeline = task.commands[1] ?? "";
  const prBody = extractPrBodyFromPipeline(pipeline);
  assert.ok(prBody.includes("jinwon"), "PR body should include requestedBy");
  assert.ok(prBody.includes("https://github.com/jinon86/test-repo/issues/3"), "PR body should include issue URL");
});

test("PR body is written to pr-body.md artifact path", () => {
  const task = normalizeTask({
    id: "pr-body-path",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
  });

  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("/work/artifacts/pr-body.md"), "PR body must be written to the pr-body.md artifact");
  assert.ok(pipeline.includes("--body-file /work/artifacts/pr-body.md"), "gh pr create must use --body-file");
});

test("PR body heredoc uses quoted delimiter to prevent shell expansion", () => {
  const task = normalizeTask({
    id: "heredoc-safety",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    issueUrl: "https://github.com/jinon86/test-repo/issues/1",
    prompt: "Fix: add $VARIABLE handling and `backtick` support.",
  });

  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("<<'A2A_PR_BODY_EOF'"), "PR body heredoc must use single-quoted delimiter to suppress shell expansion");
});

// ---------------------------------------------------------------------------
// Issue comments: presence, file-based body, shell metacharacter safety
// ---------------------------------------------------------------------------

test("no gh issue comment in pipeline when issueUrl is absent", () => {
  const task = normalizeTask({
    id: "no-issue-comment",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
  });

  const pipeline = task.commands[1] ?? "";
  assert.ok(!pipeline.includes("gh issue comment"), "Pipeline must not have issue comment when no issueUrl");
});

test("issue comment uses --body-file for safety, not inline --body arg", () => {
  const task = normalizeTask({
    id: "issue-comment-bodyfile",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    issueUrl: "https://github.com/jinon86/test-repo/issues/20",
  });

  const pipeline = task.commands[1] ?? "";
  assert.ok(pipeline.includes("--body-file /work/artifacts/issue-comment.md"), "Issue comment must use --body-file");
  assert.ok(pipeline.includes("/work/artifacts/issue-comment-output.txt"), "Issue comment output must be captured to artifact");
  // Must not use inline --body 'text' or --body "text"
  const ghCommentIdx = pipeline.indexOf("gh issue comment");
  const ghCommentLine = pipeline.slice(ghCommentIdx, pipeline.indexOf("\n", ghCommentIdx));
  assert.ok(!ghCommentLine.includes("--body '") && !ghCommentLine.includes('--body "'), "Issue comment must not use inline --body arg");
});

test("issue URL is single-quoted in gh issue comment for shell metacharacter safety", () => {
  const task = normalizeTask({
    id: "url-quoting",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    issueUrl: "https://github.com/jinon86/test-repo/issues/5",
  });

  const pipeline = task.commands[1] ?? "";
  const ghCommentIdx = pipeline.indexOf("gh issue comment");
  const ghCommentLine = pipeline.slice(ghCommentIdx, pipeline.indexOf("\n", ghCommentIdx));
  assert.ok(
    ghCommentLine.includes("'https://github.com/jinon86/test-repo/issues/5'"),
    `Issue URL must be single-quoted in gh issue comment, got: ${ghCommentLine}`,
  );
});

test("issue URL single quote is shell-escaped in gh issue comment (defensive metachar test)", () => {
  // Real GitHub URLs never have single quotes, but the quoting must handle them
  // to prevent any injection if an unusual URL is passed.
  const task = normalizeTask({
    id: "singlequote-url",
    intent: "propose_patch",
    mode: "github-propose-patch",
    repo: "jinon86/test-repo",
    baseBranch: "main",
    issueUrl: "https://github.com/jinon86/test-repo/issues/5'x",
  });

  const pipeline = task.commands[1] ?? "";
  const ghCommentIdx = pipeline.indexOf("gh issue comment");
  const ghCommentLine = pipeline.slice(ghCommentIdx, pipeline.indexOf("\n", ghCommentIdx));
  // POSIX escape: 5'x → 5'\''x — the escape sequence must appear
  assert.ok(ghCommentLine.includes("'\\''"), `Single quote in URL must be POSIX-escaped, got: ${ghCommentLine}`);
  // The fully-escaped URL argument must appear in one piece
  assert.ok(
    ghCommentLine.includes("'https://github.com/jinon86/test-repo/issues/5'\\''x'"),
    `Expected full POSIX-escaped URL in gh issue comment line, got: ${ghCommentLine}`,
  );
});
