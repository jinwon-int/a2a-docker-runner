import type { NormalizedRunnerTask, RunnerRepo, RunnerTask } from "./types.js";

const GITHUB_REPO_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeTask(task: RunnerTask): NormalizedRunnerTask {
  const repos = normalizeRepos(task);
  const primaryRepo = repos.find((repo) => repo.primary) ?? repos[0];
  const commands = task.commands?.length ? task.commands : defaultCommands(task, primaryRepo);

  return {
    ...task,
    repos,
    commands,
  };
}

export function normalizeRepoUrl(url: string): string {
  if (GITHUB_REPO_SHORTHAND.test(url)) return `https://github.com/${url}.git`;
  return url;
}

export function defaultCheckoutPath(url: string): string {
  const withoutHash = url.split("#", 1)[0] ?? url;
  const last = withoutHash.replace(/\/$/, "").split("/").pop() || "repo";
  return last.replace(/\.git$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function normalizeRepos(task: RunnerTask): RunnerRepo[] {
  const repos = [...(task.repos ?? [])];

  if (task.repo && !repos.length) {
    repos.push({
      url: task.repo,
      branch: task.baseBranch,
      path: "repo",
      primary: true,
    });
  }

  if (task.preset === "openclaw-plugin-a2a-dev" && !repos.length) {
    repos.push({
      name: "openclaw-plugin-a2a",
      url: "jinwon-int/openclaw-plugin-a2a",
      branch: task.baseBranch ?? "main",
      path: "openclaw-plugin-a2a",
      primary: true,
    });
  }

  return repos.map((repo, index) => ({
    ...repo,
    name: repo.name ?? defaultCheckoutPath(repo.url),
    url: normalizeRepoUrl(repo.url),
    branch: repo.branch ?? task.baseBranch ?? "main",
    path: sanitizeRelativePath(repo.path ?? defaultCheckoutPath(repo.url)),
    primary: repo.primary ?? index === 0,
  }));
}

export function isPatchMode(mode?: string): boolean {
  return mode === "github-propose-patch" || mode === "propose_patch";
}

function defaultCommands(task: RunnerTask, primaryRepo?: RunnerRepo): string[] {
  // Patch mode always takes priority over preset so that
  // openclaw-plugin-a2a-dev tasks in github-propose-patch / propose_patch
  // mode produce a PR instead of running test-only commands.
  if (isPatchMode(task.mode) && task.commentOnly) {
    return buildDefaultCommentOnlyCommands(task);
  }

  if (isPatchMode(task.mode) && primaryRepo) {
    return buildDefaultPatchCommands(task, primaryRepo);
  }

  if (task.preset === "openclaw-plugin-a2a-dev") {
    const dir = primaryRepo?.path ?? "openclaw-plugin-a2a";
    return [
      `cd /work/${dir} && npm ci`,
      `cd /work/${dir} && npm test`,
    ];
  }

  if (primaryRepo) {
    return [`cd /work/${primaryRepo.path} && npm ci`, `cd /work/${primaryRepo.path} && npm test`];
  }

  return [];
}

function buildDefaultCommentOnlyCommands(task: RunnerTask): string[] {
  const safeTitle = (task.id || "a2a-closeout").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const existingPrUrl = task.existingPrUrl ?? buildExistingPrUrl(task);

  return [[
    `cat > /work/artifacts/prompt.md << 'A2A_PROMPT_EOF'`,
    task.prompt ?? `Comment-only closeout task ${task.id}`,
    `A2A_PROMPT_EOF`,
    `printf 'patch_mode=comment_only\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'new_pr_allowed=0\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'task=%s\\n' ${shellSingleQuote(safeTitle)} | tee -a /work/artifacts/summary.txt`,
    ...(existingPrUrl ? [`printf 'existing_pr=%s\\n' ${shellSingleQuote(existingPrUrl)} | tee -a /work/artifacts/summary.txt`] : []),
    `printf 'status=comment_only_done\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n")];
}

function buildDefaultPatchCommands(task: RunnerTask, primaryRepo: RunnerRepo): string[] {
  const repoPath = primaryRepo.path ?? "repo";
  const baseBranch = task.baseBranch ?? primaryRepo.branch ?? "main";
  const safeTitle = (task.id || "a2a-patch").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const issueCommentTarget = task.issueUrl ? shellSingleQuote(task.issueUrl) : "";
  const issueClosingRef = buildIssueClosingRef(task, primaryRepo);
  const prBody = buildPrBody(task, safeTitle, issueClosingRef);

  // Step 1: materialise prompt + task metadata as artifacts.
  const writePrompt = [
    `cat > /work/artifacts/prompt.md << 'A2A_PROMPT_EOF'`,
    task.prompt ?? `Auto-patch task ${task.id}`,
    `A2A_PROMPT_EOF`,
    `printf 'patch_mode=github-propose-patch\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'prompt_bytes=%s\\n' "$(wc -c < /work/artifacts/prompt.md)" | tee -a /work/artifacts/summary.txt`,
  ].join("\n");

  // Step 2: git config + branch + coding agent + commit + push + PR create.
  // Everything that shares shell variables lives in one command so BRANCH
  // and change detection work across the pipeline.
  //
  // Patch command execution contract (priority order):
  //   1. /work/patch-command.sh  →  safe script file (commandScript / commandJson)
  //   2. $A2A_PATCH_COMMAND_JSON  →  JSON argv/env (should be pre-converted; safety net)
  //   3. $A2A_PATCH_COMMAND       →  LEGACY eval (deprecated, kept for compatibility)
  const patchCommandBlock = [
    `# Patch command execution: safe script file (recommended).`,
    `if [ -x /work/patch-command.sh ]; then`,
    `  printf 'patch_mode=script\\n' | tee -a /work/artifacts/summary.txt`,
    `  /work/patch-command.sh 2>&1 | tee /work/artifacts/patch-command.log`,
    `elif [ -n "\${A2A_PATCH_COMMAND_JSON:-}" ]; then`,
    `  printf 'patch_mode=json_argv_unconverted\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'error=json_argv_received_without_host_side_script_conversion\\n' >&2`,
    `  exit 2`,
    `elif [ -n "\${A2A_PATCH_COMMAND:-}" ]; then`,
    `  printf 'patch_mode=legacy_eval\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'warning=deprecated_eval_path_prefer_commandScript_or_commandJson\\n' | tee -a /work/artifacts/summary.txt`,
    `  eval "\${A2A_PATCH_COMMAND}" 2>&1 | tee /work/artifacts/patch-command.log`,
    `else`,
    `  printf 'error=no_patch_command_configured\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT or A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON to inject a host-side OpenClaw/Codex coding agent.\\n' | tee /work/artifacts/patch-command.log`,
    `  exit 2`,
    `fi`,
  ].join("\n");

  const startCommentBlock = task.issueUrl ? [
    `printf 'Start\\n' > /work/artifacts/issue-start-comment.md`,
    `if ! command -v gh >/dev/null 2>&1; then`,
    `  printf 'error=gh_unavailable_start_comment_required\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'GitHub literal Start comment is required before patch execution, but gh is unavailable.\\n' | tee /work/artifacts/issue-start-comment-output.txt`,
    `  exit 2`,
    `fi`,
    `if ! gh issue comment ${issueCommentTarget} --body-file /work/artifacts/issue-start-comment.md 2>&1 | tee /work/artifacts/issue-start-comment-output.txt; then`,
    `  printf 'error=start_comment_failed\\n' | tee -a /work/artifacts/summary.txt`,
    `  exit 2`,
    `fi`,
    `printf 'start_comment=posted\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n") : "";

  const prePrBootstrapGuardBlock = [
    `# Re-run the bootstrap guard immediately before git add/commit/push.`,
    `# The container-level post-guard is too late for PR safety because the`,
    `# default pipeline creates the branch before returning to run.sh.`,
    `: "\${BOOTSTRAP_BANNED:=AGENTS.md BOOTSTRAP.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md}"`,
    `: "\${BOOTSTRAP_BANNED_DIRS:=.openclaw memory}"`,
    `if ! command -v find_bootstrap_leaks >/dev/null 2>&1; then`,
    `  find_bootstrap_leaks() {`,
    `    repo_dir="$1"`,
    `    (`,
    `      cd "$repo_dir"`,
    `      for name in $BOOTSTRAP_BANNED; do`,
    `        if [ -e "$name" ]; then printf '%s\\n' "$name"; fi`,
    `      done`,
    `      for name in $BOOTSTRAP_BANNED_DIRS; do`,
    `        if [ -d "$name" ]; then`,
    `          found=0`,
    `          while IFS= read -r path; do`,
    `            found=1`,
    `            printf '%s\\n' "\${path#./}"`,
    `          done < <(find "$name" -mindepth 1 -print | sort)`,
    `          if [ "$found" -eq 0 ]; then printf '%s\\n' "$name"; fi`,
    `        fi`,
    `      done`,
    `    )`,
    `  }`,
    `fi`,
    `if ! command -v filter_branch_bootstrap_leaks >/dev/null 2>&1; then`,
    `  filter_branch_bootstrap_leaks() {`,
    `    repo_dir="$1"`,
    `    if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `      cat`,
    `      return`,
    `    fi`,
    `    while IFS= read -r path; do`,
    `      [ -n "$path" ] || continue`,
    `      if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] || [ -n "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then`,
    `        printf '%s\\n' "$path"`,
    `      fi`,
    `    done`,
    `  }`,
    `fi`,
    `BOOTSTRAP_LEAKS_BEFORE_PR="$(find_bootstrap_leaks "." | filter_branch_bootstrap_leaks "." || true)"`,
    `ARTIFACT_BOOTSTRAP_LEAKS_BEFORE_PR="$(`,
    `  cd /work/artifacts`,
    `  for name in $BOOTSTRAP_BANNED; do`,
    `    if [ -e "$name" ]; then printf 'artifacts/%s\\n' "$name"; fi`,
    `  done`,
    `  for name in $BOOTSTRAP_BANNED_DIRS; do`,
    `    if [ -d "$name" ]; then`,
    `      found=0`,
    `      while IFS= read -r path; do`,
    `        found=1`,
    `        printf 'artifacts/%s\\n' "\${path#./}"`,
    `      done < <(find "$name" -mindepth 1 -print | sort)`,
    `      if [ "$found" -eq 0 ]; then printf 'artifacts/%s\\n' "$name"; fi`,
    `    fi`,
    `  done`,
    `)"`,
    `BOOTSTRAP_BLOCK_PATHS="$(printf '%s\\n%s\\n' "$BOOTSTRAP_LEAKS_BEFORE_PR" "$ARTIFACT_BOOTSTRAP_LEAKS_BEFORE_PR" | sed '/^$/d')"`,
    `if [ -n "$BOOTSTRAP_BLOCK_PATHS" ]; then`,
    `  printf 'error=pre_pr_bootstrap_guard_blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'PR blocked: OpenClaw bootstrap context files appeared before PR creation or artifact evidence capture.\\n' | tee /work/artifacts/patch-command.log`,
    `  printf 'Parent: a2a-broker#446\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf 'Files detected (repo-relative or artifact-relative):\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$BOOTSTRAP_BLOCK_PATHS" | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$BOOTSTRAP_BLOCK_PATHS" | sed '/^$/d; s#^#bootstrap_leak=#' >> /work/artifacts/summary.txt`,
    `  exit 4`,
    `fi`,
  ].join("\n");

  const issueCommentBlock = task.issueUrl ? [
    `  cat > /work/artifacts/issue-comment.md <<A2A_ISSUE_COMMENT_EOF`,
    `PR: $PR_URL`,
    ``,
    `A2A task: ${safeTitle}`,
    `A2A_ISSUE_COMMENT_EOF`,
    `  gh issue comment ${issueCommentTarget} --body-file /work/artifacts/issue-comment.md 2>&1 | tee /work/artifacts/issue-comment-output.txt || true`,
  ].join("\n") : "";

  const pipeline = [
    `set -euo pipefail`,
    `cd /work/${repoPath}`,
    `git config user.email "a2a-runner@openclaw.ai"`,
    `git config user.name "A2A Docker Runner"`,
    `BRANCH="a2a-patch-$(date +%Y%m%d-%H%M%S)-${safeTitle}"`,
    `git checkout -b "$BRANCH"`,
    `printf 'branch=%s\\n' "$BRANCH" | tee -a /work/artifacts/summary.txt`,
    ``,
    startCommentBlock,
    ``,
    patchCommandBlock,
    ``,
    `# A coding agent must not manage git branches itself, but some do.`,
    `# Normalize back to the runner-owned branch before commit/push so we`,
    `# never push the pre-agent empty branch and then fail with`,
    `# "No commits between main and <branch>".`,
    `CURRENT_BRANCH="$(git branch --show-current || true)"`,
    `if [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "$BRANCH" ]; then`,
    `  printf 'notice=agent_changed_branch from=%s to=%s\n' "$CURRENT_BRANCH" "$BRANCH" | tee -a /work/artifacts/summary.txt`,
    `  if git diff --quiet && git diff --cached --quiet; then`,
    `    git branch -f "$BRANCH" HEAD`,
    `    git checkout "$BRANCH"`,
    `  else`,
    `    git checkout "$BRANCH"`,
    `  fi`,
    `fi`,
    prePrBootstrapGuardBlock,
    `EXISTING_PR_URL="$(grep -RhoE 'https://github.com/[^[:space:]]+/pull/[0-9]+' /work/artifacts 2>/dev/null | tail -n 1 || true)"`,
    `# Commit and create PR if changes exist or the agent already committed.`,
    `if [ -n "$(git status --porcelain)" ] || ! git diff --quiet "origin/${baseBranch}...HEAD"; then`,
    ...(task.forbidNewPr ? [
      `  printf 'error=new_pr_forbidden\\n' | tee -a /work/artifacts/summary.txt`,
      `  printf 'Task forbids creating a new PR; use an existing PR refresh path or comment-only closeout.\\n' | tee /work/artifacts/pr-output.txt`,
      `  exit 2`,
    ] : [
      `  if [ -n "$(git status --porcelain)" ]; then`,
      `    git add -A`,
      `    git commit -m "Auto-patch: ${safeTitle}"`,
      `  else`,
      `    printf 'notice=agent_already_committed_changes\n' | tee -a /work/artifacts/summary.txt`,
      `  fi`,
      `  git push origin HEAD:"$BRANCH"`,
      `  cat > /work/artifacts/pr-body.md <<'A2A_PR_BODY_EOF'`,
      prBody,
      `A2A_PR_BODY_EOF`,
      `  gh pr create --base "${baseBranch}" --head "$BRANCH" \\`,
      `    --title "Patch: ${safeTitle}" \\`,
      `    --body-file /work/artifacts/pr-body.md \\`,
      `    2>&1 | tee /work/artifacts/pr-output.txt || true`,
    ]),
    `  PR_URL="$(grep -Eo 'https://github.com/[^[:space:]]+/pull/[0-9]+' /work/artifacts/pr-output.txt | tail -n 1 || true)"`,
    `  if [ -z "$PR_URL" ] && [ -n "$EXISTING_PR_URL" ]; then`,
    `    PR_URL="$EXISTING_PR_URL"`,
    `    printf 'notice=using_existing_pr_url_from_artifacts\n' | tee -a /work/artifacts/summary.txt`,
    `  fi`,
    `  if [ -z "$PR_URL" ]; then`,
    `    printf 'error=pr_create_failed_or_missing_url\\n' | tee -a /work/artifacts/summary.txt`,
    `    exit 2`,
    `  fi`,
    `  printf 'pr_created=1\\n' | tee -a /work/artifacts/summary.txt`,
    `  if command -v a2a-gh-pr-update-branch >/dev/null 2>&1; then`,
    `    if a2a-gh-pr-update-branch "$PR_URL" "${baseBranch}" 2>&1 | tee /work/artifacts/pr-update-branch-output.txt; then`,
    `      printf 'pr_update_branch=ok\\n' | tee -a /work/artifacts/summary.txt`,
    `    else`,
    `      printf 'warning=pr_update_branch_failed\\n' | tee -a /work/artifacts/summary.txt`,
    `    fi`,
    `  fi`,
    issueCommentBlock,
    `else`,
    ...(task.allowNoChanges
      ? [
        `  printf 'status=no_changes_allowed\\n' | tee -a /work/artifacts/summary.txt`,
        `  printf 'notice=no_code_changes_produced_evidence_only_lane\\n' | tee -a /work/artifacts/summary.txt`,
      ]
      : [
        `  printf 'error=no_changes_after_patch_command\\n' | tee -a /work/artifacts/summary.txt`,
        `  exit 2`,
      ]),
    `fi`,
  ].join("\n");

  return [writePrompt, pipeline];
}

function buildPrBody(task: RunnerTask, safeTitle: string, issueClosingRef?: string): string {
  const lines = [
    `Auto-generated patch for task \`${safeTitle}\`.`,
    ...(task.issueUrl ? [`Issue: ${singleLine(task.issueUrl)}`] : []),
    ...(task.requestedBy ? [`Requested by: ${singleLine(task.requestedBy)}`] : []),
    ...(issueClosingRef ? ["", `Closes ${issueClosingRef}`] : []),
    "",
    "---",
    "See artifacts/prompt.md for full prompt.",
  ];
  return lines.join("\n");
}

function buildExistingPrUrl(task: RunnerTask): string | undefined {
  const repo = task.repo ?? task.repos?.find((candidate) => candidate.primary)?.url ?? task.repos?.[0]?.url;
  const repoSlug = repo ? parseGitHubRepoSlug(repo) : undefined;
  const rawNumber = task.existingPrNumber != null ? String(task.existingPrNumber) : undefined;
  const prNumber = rawNumber?.match(/#?(\d+)/)?.[1];
  if (!repoSlug || !prNumber) return undefined;
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}

function buildIssueClosingRef(task: RunnerTask, primaryRepo: RunnerRepo): string | undefined {
  const issue = parseGitHubIssueUrl(task.issueUrl);
  if (!issue) return undefined;
  const primaryRepoSlug = parseGitHubRepoSlug(primaryRepo.url);
  if (primaryRepoSlug && primaryRepoSlug.toLowerCase() === issue.repo.toLowerCase()) {
    return `#${issue.number}`;
  }
  return `${issue.repo}#${issue.number}`;
}

function parseGitHubIssueUrl(issueUrl?: string): { repo: string; number: string } | undefined {
  const match = issueUrl?.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:$|[/?#])/);
  return match ? { repo: match[1] ?? "", number: match[2] ?? "" } : undefined;
}

function parseGitHubRepoSlug(repoUrl: string): string | undefined {
  const normalized = normalizeRepoUrl(repoUrl);
  const match = normalized.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return match?.[1];
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sanitizeRelativePath(path: string): string {
  const cleaned = path.replace(/^\/+/, "").replace(/\.\./g, "_");
  if (!cleaned || cleaned === ".") return "repo";
  return cleaned;
}
