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
      url: "jinon86/openclaw-plugin-a2a",
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
  if (task.preset === "openclaw-plugin-a2a-dev") {
    const dir = primaryRepo?.path ?? "openclaw-plugin-a2a";
    return [
      `cd /work/${dir} && npm ci`,
      `cd /work/${dir} && npm test`,
    ];
  }

  // github-propose-patch / propose_patch mode with no explicit commands.
  // Generate a PR-producing pipeline that writes the prompt to artifacts,
  // invokes a coding agent via a safe script file, and
  // commits/pushes/creates a PR when changes are detected.
  if (isPatchMode(task.mode) && primaryRepo) {
    return buildDefaultPatchCommands(task, primaryRepo);
  }

  if (primaryRepo) {
    return [`cd /work/${primaryRepo.path} && npm ci`, `cd /work/${primaryRepo.path} && npm test`];
  }

  return [];
}

function buildDefaultPatchCommands(task: RunnerTask, primaryRepo: RunnerRepo): string[] {
  const repoPath = primaryRepo.path ?? "repo";
  const baseBranch = task.baseBranch ?? primaryRepo.branch ?? "main";
  const safeTitle = (task.id || "a2a-patch").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const issueRef = task.issueUrl ? `\nIssue: ${task.issueUrl}` : "";
  const requesterRef = task.requestedBy ? `\nRequested by: ${task.requestedBy}` : "";

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
    `  printf 'notice=no_patch_command_configured\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'Set commandScript or commandJson in RunnerConfig to inject a coding agent.\\n' | tee /work/artifacts/patch-command.log`,
    `fi`,
  ].join("\n");

  const pipeline = [
    `set -euo pipefail`,
    `cd /work/${repoPath}`,
    `git config user.email "a2a-runner@openclaw.ai"`,
    `git config user.name "A2A Docker Runner"`,
    `BRANCH="a2a-patch-$(date +%Y%m%d-%H%M%S)-${safeTitle}"`,
    `git checkout -b "$BRANCH"`,
    `printf 'branch=%s\\n' "$BRANCH" | tee -a /work/artifacts/summary.txt`,
    ``,
    patchCommandBlock,
    ``,
    `# Commit and create PR if changes exist.`,
    `if [ -n "$(git status --porcelain)" ]; then`,
    `  git add -A`,
    `  git commit -m "Auto-patch: ${safeTitle}"`,
    `  git push origin "$BRANCH"`,
    `  gh pr create --base "${baseBranch}" --head "$BRANCH" \\`,
    `    --title "Patch: ${safeTitle}" \\`,
    `    --body "$(printf 'Auto-generated patch for task \`%s\`.%s%s\\n\\n---\\nSee artifacts/prompt.md for full prompt.' "${safeTitle}" "${issueRef}" "${requesterRef}")" \\`,
    `    2>&1 | tee /work/artifacts/pr-output.txt || true`,
    `  if grep -q 'https://github.com/' /work/artifacts/pr-output.txt 2>/dev/null; then`,
    `    printf 'pr_created=1\\n' | tee -a /work/artifacts/summary.txt`,
    `  fi`,
    `else`,
    `  printf 'status=no_changes\\n' | tee -a /work/artifacts/summary.txt`,
    `fi`,
  ].join("\n");

  return [writePrompt, pipeline];
}

function sanitizeRelativePath(path: string): string {
  const cleaned = path.replace(/^\/+/, "").replace(/\.\./g, "_");
  if (!cleaned || cleaned === ".") return "repo";
  return cleaned;
}
