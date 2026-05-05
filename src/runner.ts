import { mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { normalizeTask } from "./task-normalizer.js";
import { collectGitHubEvidence } from "./github-evidence.js";
import type { ArtifactEvidencePart, ArtifactManifest, ArtifactManifestEntry, ArtifactManifestStatus, NormalizedRunnerTask, ResultSummary, RunnerBudgetEvidence, RunnerConfig, RunnerContinuationEvidence, RunnerEvidenceHints, RunnerReceiptTrace, RunnerResult, RunnerTask } from "./types.js";

export async function runTask(config: RunnerConfig, task: RunnerTask): Promise<RunnerResult> {
  validateTask(task);
  const normalizedTask = normalizeTask(task);
  const root = resolve(config.rootDir);
  const runToken = createRunToken();
  const safeTaskId = safeId(task.id);
  const taskRoot = join(root, safeTaskId);
  const workDir = join(taskRoot, runToken);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: false, mode: 0o700 });
  await writeFile(join(workDir, "task.json"), JSON.stringify(normalizedTask, null, 2));
  await writeFile(join(workDir, "run.json"), JSON.stringify({
    taskId: task.id,
    safeTaskId,
    runToken,
    createdAt: new Date().toISOString(),
    ...(config.buildMetadata ? { runnerBuild: config.buildMetadata } : {}),
  }, null, 2));

  // Write safe patch command script if configured.
  // Priority: commandScript > commandJson > commandTemplate (legacy eval).
  if (config.commandScript) {
    await writeFile(join(workDir, "patch-command.sh"), config.commandScript, { mode: 0o700 });
  } else if (config.commandJson) {
    const jsonScript = jsonArgvToScript(config.commandJson);
    await writeFile(join(workDir, "patch-command.sh"), jsonScript, { mode: 0o700 });
  }

  const script = buildContainerScript(normalizedTask);
  await writeFile(join(workDir, "run.sh"), script, { mode: 0o700 });

  const args = buildRunArgs(config, normalizedTask, workDir, runToken);
  const timeoutMs = normalizedTask.timeoutMs ?? config.defaultTimeoutMs;
  const engine = config.engine ?? "docker";
  const completed = await spawnWithTimeout(engine, args, timeoutMs);
  const artifacts = await listArtifacts(workDir);
  const stdout = redactAndBound(completed.stdout);
  const stderr = redactAndBound(completed.stderr);
  const prUrl = extractPrUrl(completed.stdout);
  const budgetStop = inferBudgetStopEvidence(stdout, stderr);
  const receiptTrace = sanitizeReceiptTrace(normalizedTask.receiptTrace ?? parseReceiptTraceEnv(normalizedTask.env));
  const manifest = await buildArtifactManifest(workDir, artifacts, {
    task: normalizedTask,
    status: budgetStop ? "budget_limited" : completed.timedOut ? "failed" : completed.code === 0 ? "done" : "failed",
    stdout,
    stderr,
    prUrl,
    receiptTrace,
    ...(budgetStop ? budgetStop : {}),
  });
  await writeArtifactManifest(workDir, manifest);
  const resultSummary = buildResultSummary(completed, stdout, stderr, artifacts, manifest, config.buildMetadata);

  const result: RunnerResult = {
    ok: completed.code === 0 && !completed.timedOut,
    taskId: task.id,
    status: completed.timedOut ? "timeout" : completed.code === 0 ? "completed" : "failed",
    workDir,
    exitCode: completed.code,
    signal: completed.signal,
    stdout,
    stderr,
    artifacts,
    artifactManifest: manifest,
    resultSummary,
    runnerBuild: config.buildMetadata,
    prUrl,
    error: completed.code === 0 && !completed.timedOut ? undefined : buildActionableError(engine, config.image, completed),
  };

  if (isMissingPatchCommand(stdout, stderr)) {
    result.ok = false;
    result.status = "failed";
    result.error = "GitHub patch task reached the default pipeline, but no coding-agent patch command was configured. Configure A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT or A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON and retry.";
  }

  // Collect structured GitHub evidence for propose_patch / github-propose-patch mode.
  const github = await collectGitHubEvidence(config, normalizedTask, result);
  if (github) {
    result.github = github;
    // Backward-compatible: promote to top-level prUrl if github.prUrl is set.
    if (github.prUrl && !result.prUrl) result.prUrl = github.prUrl;
    // Fail closed: GitHub patch tasks must end with PR/Done/Block evidence.
    if (github.outcome === "missing_evidence") {
      result.ok = false;
      result.status = "failed";
      result.error = "GitHub patch task completed without PR/Done/Block evidence. Treating as failed closed until canonical evidence is available.";
      if (result.github.validation) {
        result.github.validation.status = result.status;
      }
    }
    const evidenceHints = buildRunnerEvidenceHints(normalizedTask, result);
    if (evidenceHints) {
      result.artifactManifest = { ...result.artifactManifest!, evidenceHints };
      result.resultSummary = { ...result.resultSummary!, evidenceHints };
      await writeArtifactManifest(workDir, result.artifactManifest);
    }
  }

  return result;
}

function isMissingPatchCommand(stdout: string, stderr: string): boolean {
  return [stdout, stderr]
    .flatMap((text) => text.split(/\r?\n/).map((line) => line.trim()))
    .some((line) => line === "notice=no_patch_command_configured" || line === "error=no_patch_command_configured");
}

export function buildRunnerEvidenceHints(task: NormalizedRunnerTask, result: RunnerResult): RunnerEvidenceHints | undefined {
  const github = result.github;
  const branch = safeHintText(github?.branch ?? result.artifactManifest?.branch);
  const repo = safeGitHubRepoSlug(github?.repo ?? result.artifactManifest?.repo ?? task.repo);
  const failureCategory = inferEvidenceFailureCategory(result);
  const hint: RunnerEvidenceHints = {
    schemaVersion: "a2a.runner.evidence-hints.v1",
    ...(safeGitHubUrl(task.issueUrl ?? result.artifactManifest?.issueUrl, "issues") ? { issueUrl: task.issueUrl ?? result.artifactManifest?.issueUrl } : {}),
    ...(safeGitHubUrl(github?.prUrl ?? result.prUrl ?? result.artifactManifest?.prUrl, "pull") ? { prUrl: github?.prUrl ?? result.prUrl ?? result.artifactManifest?.prUrl } : {}),
    ...(safeGitHubUrl(github?.doneUrl ?? github?.doneCommentUrl, "issues") ? { doneUrl: github?.doneUrl ?? github?.doneCommentUrl } : {}),
    ...(safeGitHubUrl(github?.blockUrl ?? github?.blockCommentUrl, "issues") ? { blockUrl: github?.blockUrl ?? github?.blockCommentUrl } : {}),
    ...(branch ? { branch } : {}),
    ...(repo && branch ? { branchUrl: buildBranchUrl(repo, branch) } : {}),
    ...(failureCategory ? { failureCategory } : {}),
  };
  return Object.keys(hint).length > 1 ? hint : undefined;
}

function inferEvidenceFailureCategory(result: RunnerResult): RunnerEvidenceHints["failureCategory"] | undefined {
  const outcome = result.github?.outcome;
  if (outcome === "block" || outcome === "budget_limited" || outcome === "timed_out" || outcome === "missing_evidence") return outcome;
  if (result.status === "timeout") return "timed_out";
  if (result.resultSummary?.status === "budget_limited" || result.artifactManifest?.status === "budget_limited") return "budget_limited";
  if (!result.ok && typeof result.exitCode === "number" && result.exitCode !== 0) return "exit_nonzero";
  if (!result.ok) return "failed";
  return undefined;
}

function buildBranchUrl(repo: string, branch: string): string {
  return "https://github.com/" + repo + "/tree/" + branch.split("/").map(encodeURIComponent).join("/");
}

function safeGitHubRepoSlug(value: string | undefined): string | undefined {
  if (!value || hasUnsafeHintContent(value)) return undefined;
  const slugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (slugPattern.test(value)) return value;
  const match = value.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return match?.[1] && slugPattern.test(match[1]) ? match[1] : undefined;
}

function safeGitHubUrl(value: string | undefined, kind: "issues" | "pull"): boolean {
  if (!value || hasUnsafeHintContent(value)) return false;
  try {
    const url = new URL(value);
    const urlPattern = new RegExp("^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/" + kind + "/\\d+(?:#issuecomment-\\d+)?$");
    return url.protocol === "https:" && url.hostname === "github.com" && urlPattern.test(url.pathname + url.hash);
  } catch {
    return false;
  }
}

function safeHintText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = redactAndBound(value.replace(/[\r\n]+/g, " ").trim(), 160);
  if (!safe || hasUnsafeHintContent(safe)) return undefined;
  return safe;
}

function hasUnsafeHintContent(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Authorization:\s*(?:Bearer|token)|\/root\/|\/home\/|\/tmp\/|\/var\/folders\/|token=|password=|secret=|api[_-]?key=)/i.test(value);
}

function validateTask(task: RunnerTask): void {
  if (!task.id) throw new Error("task.id is required");
  if (!task.intent) throw new Error("task.intent is required");
}

function safeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^[-.]+/, "_").slice(0, 80);
  return safe || "task";
}

function createRunToken(): string {
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 15);
  const random = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${process.pid.toString(36)}-${random}`;
}

function buildContainerName(taskId: string, runToken: string): string {
  return `a2a-${safeId(taskId)}-${runToken}`.slice(0, 128);
}

export function buildRunArgs(config: RunnerConfig, task: RunnerTask, workDir: string, runToken = createRunToken()): string[] {
  const containerName = buildContainerName(task.id, runToken);
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    config.network ?? "bridge",
    "--label",
    `a2a.task.id=${safeId(task.id)}`,
    "--label",
    `a2a.run.id=${runToken}`,
    "--memory",
    config.memory ?? "2g",
    "--cpus",
    config.cpus ?? "2",
    "-v",
    `${workDir}:/work`,
    "-w",
    "/work",
  ];

  if (config.githubTokenFile) {
    args.push("-v", `${config.githubTokenFile}:/run/secrets/gh-hosts.yml:ro`);
    args.push("-e", "GH_CONFIG_HOSTS=/run/secrets/gh-hosts.yml");
  }

  for (const mount of config.extraMounts ?? []) {
    const mode = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", `${mount.source}:${mount.target}:${mode}`);
  }

  // Safe patch command paths are mutually exclusive by priority:
  // commandScript > commandJson > commandTemplate (legacy eval).
  // commandScript is mounted as /work/patch-command.sh, so it needs no env var.
  if (config.commandScript) {
    // no-op: runTask writes /work/patch-command.sh
  } else if (config.commandJson) {
    args.push("-e", `A2A_PATCH_COMMAND_JSON=${config.commandJson}`);
  } else if (config.commandTemplate) {
    args.push("-e", `A2A_PATCH_COMMAND=${config.commandTemplate}`);
  }

  for (const [key, value] of Object.entries(buildMetadataEnv(config))) {
    args.push("-e", `${key}=${value}`);
  }

  for (const [key, value] of Object.entries(task.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(config.image, "bash", "/work/run.sh");
  return args;
}

function buildMetadataEnv(config: RunnerConfig): Record<string, string> {
  const build = config.buildMetadata;
  if (!build) return {};
  return Object.fromEntries(Object.entries({
    A2A_RUNNER_BUILD_VERSION: build.version,
    A2A_RUNNER_BUILD_SOURCE: build.source,
    A2A_RUNNER_BUILD_REVISION: build.revision,
    A2A_RUNNER_BUILD_BUILT_AT: build.builtAt,
    A2A_RUNNER_BUILD_IMAGE: build.image,
  }).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
}

export function buildContainerScript(task: NormalizedRunnerTask): string {
  return `#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work/artifacts
printf 'A2A Docker Runner task %s\n' ${shellQuote(task.id)} | tee /work/artifacts/summary.txt
printf 'intent=%s\n' ${shellQuote(task.intent)} | tee -a /work/artifacts/summary.txt
printf 'preset=%s\n' ${shellQuote(task.preset ?? "")} | tee -a /work/artifacts/summary.txt
if [ -n "\${A2A_RUNNER_BUILD_VERSION:-}" ]; then printf 'runner.version=%s\n' "$A2A_RUNNER_BUILD_VERSION" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_REVISION:-}" ]; then printf 'runner.revision=%s\n' "$A2A_RUNNER_BUILD_REVISION" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_SOURCE:-}" ]; then printf 'runner.source=%s\n' "$A2A_RUNNER_BUILD_SOURCE" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_BUILT_AT:-}" ]; then printf 'runner.builtAt=%s\n' "$A2A_RUNNER_BUILD_BUILT_AT" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_IMAGE:-}" ]; then printf 'runner.image=%s\n' "$A2A_RUNNER_BUILD_IMAGE" | tee -a /work/artifacts/summary.txt; fi
${installBaseToolsScript()}
${installGhUpdateBranchFallbackScript()}
${githubAuthScript()}
${checkoutReposScript(task)}
cat /work/task.json > /work/artifacts/task.json
${runCommandsScript(task)}
printf 'status=completed\n' | tee -a /work/artifacts/summary.txt
`;
}

function installBaseToolsScript(): string {
  return `if ! command -v git >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'error=missing_git_and_apt_get_unavailable\n' >&2
    exit 2
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y git ca-certificates >/dev/null
fi

if ! command -v gh >/dev/null 2>&1 || ! gh pr update-branch --help >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'error=missing_or_unsupported_gh_and_apt_get_unavailable\n' >&2
    exit 2
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y git ca-certificates curl gnupg >/dev/null
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list
  apt-get update >/dev/null
  apt-get install -y gh >/dev/null
fi
printf 'github_cli=%s\n' "$(gh --version | head -n 1)" | tee -a /work/artifacts/summary.txt
`;
}

function installGhUpdateBranchFallbackScript(): string {
  return `cat > /usr/local/bin/a2a-gh-pr-update-branch <<'A2A_GH_UPDATE_BRANCH_EOF'
#!/usr/bin/env bash
set -euo pipefail
selector="\${1:-}"
base_override="\${2:-}"

args=()
if [ -n "$selector" ]; then
  args+=("$selector")
fi

if gh pr update-branch "\${args[@]}"; then
  exit 0
fi

printf 'warning=gh_pr_update_branch_failed_using_git_fallback\n' >&2

view_args=()
if [ -n "$selector" ]; then
  view_args+=("$selector")
fi

head_ref="$(gh pr view "\${view_args[@]}" --json headRefName --jq .headRefName 2>/dev/null || true)"
base_ref="$base_override"
if [ -z "$base_ref" ]; then
  base_ref="$(gh pr view "\${view_args[@]}" --json baseRefName --jq .baseRefName 2>/dev/null || true)"
fi
if [ -z "$head_ref" ]; then
  head_ref="$(git rev-parse --abbrev-ref HEAD)"
fi
if [ -z "$base_ref" ]; then
  base_ref="main"
fi

git fetch origin "$base_ref"
current_ref="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_ref" != "$head_ref" ]; then
  git fetch origin "$head_ref"
  git checkout -B "$head_ref" "origin/$head_ref"
fi
git merge --no-edit "origin/$base_ref"
git push origin "$head_ref"
A2A_GH_UPDATE_BRANCH_EOF
chmod 755 /usr/local/bin/a2a-gh-pr-update-branch
`;
}

function githubAuthScript(): string {
  return `if [ -r /run/secrets/gh-hosts.yml ]; then
  token=$(sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' /run/secrets/gh-hosts.yml | head -n 1)
  if [ -n "$token" ]; then
    cat > /tmp/git-askpass <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\\n' "x-access-token" ;;
  *Password*) sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' /run/secrets/gh-hosts.yml | head -n 1 ;;
  *) printf '\\n' ;;
esac
ASKPASS
    chmod 700 /tmp/git-askpass
    mkdir -p /root/.config/gh
    cp /run/secrets/gh-hosts.yml /root/.config/gh/hosts.yml
    chmod 600 /root/.config/gh/hosts.yml
    export GH_CONFIG_DIR=/root/.config/gh
    export GH_TOKEN="$token"
    export GIT_ASKPASS=/tmp/git-askpass
    export GIT_TERMINAL_PROMPT=0
    printf 'github_auth=hosts.yml\\n' | tee -a /work/artifacts/summary.txt
  fi
fi
`;
}

function checkoutReposScript(task: NormalizedRunnerTask): string {
  if (!task.repos.length) return "";
  return task.repos.map((repo) => {
    return `printf 'checkout %s %s -> %s\n' ${shellQuote(repo.name ?? repo.url)} ${shellQuote(repo.branch ?? "main")} ${shellQuote(repo.path ?? "repo")} | tee -a /work/artifacts/summary.txt
git clone --depth=1 --branch ${shellQuote(repo.branch ?? "main")} ${shellQuote(repo.url)} ${shellQuote(`/work/${repo.path ?? "repo"}`)}
`;
  }).join("\n");
}

function runCommandsScript(task: NormalizedRunnerTask): string {
  if (!task.commands.length) {
    return "printf 'commands=none\\n' | tee -a /work/artifacts/summary.txt\n";
  }

  const commands = task.commands.map((command, index) => {
    return `printf 'command[%s]=%s\n' ${shellQuote(String(index))} ${shellQuote(command)} | tee -a /work/artifacts/summary.txt
(${command}) 2>&1 | tee /work/artifacts/command-${index}.log
`;
  }).join("\n");

  return `printf 'commands=%s\n' ${shellQuote(String(task.commands.length))} | tee -a /work/artifacts/summary.txt
${commands}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Convert a JSON argv/env config into a safe bash script.
 *
 * Input:  {"argv":["codex","exec","--full-auto","..."],"env":{"KEY":"val"}}
 * Output: A self-contained bash script that executes argv safely,
 *         with optional env vars set, and never calls eval.
 */
export function jsonArgvToScript(json: string): string {
  let parsed: { argv?: unknown; env?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `#!/usr/bin/env bash
set -euo pipefail
printf 'error=json_parse_failed: %s\\n' >&2 "${shellQuote(msg)}"
exit 2
`;
  }

  if (!Array.isArray(parsed.argv) || parsed.argv.length === 0 || !parsed.argv.every((a): a is string => typeof a === "string")) {
    return `#!/usr/bin/env bash
set -euo pipefail
printf 'error=invalid_json_argv: argv must be a non-empty array of strings\\n' >&2
exit 2
`;
  }

  const envLines: string[] = [];
  if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
    for (const [key, value] of Object.entries(parsed.env as Record<string, unknown>)) {
      if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        envLines.push(`export ${key}=${shellQuote(value)}`);
      }
    }
  }

  const argvQuoted = parsed.argv.map((a: string) => shellQuote(a)).join(" ");

  return `#!/usr/bin/env bash
set -euo pipefail
${envLines.join("\n")}
${envLines.length ? "\n" : ""}exec ${argvQuoted}
`;
}
export const RESULT_STREAM_LIMIT = 8_000;


export function redactSecrets(value: string): string {
  return value
    // GitHub tokens (classic + fine-grained + PAT v2)
    .replace(new RegExp("gh[pousr]" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    .replace(new RegExp("github" + "_pat" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    // xai / supermemory / openai API key patterns (synthetic format)
    // Must fire BEFORE generic key=value redaction to catch the full key.
    .replace(/xai-[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sm_[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, "<redacted-api-key>")
    // x-access-token in URLs
    .replace(/x-access-token:[^@\s]+@github\.com/g, "x-access-token:<redacted>@github.com")
    // oauth_token in YAML/JSON
    .replace(/(oauth_token:\s*)\S+/gi, "$1<redacted>")
    // Authorization / Bearer headers
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/(gh auth login --with-token\s+)\S+/gi, "$1<redacted>")
    // Generic key=value and JSON/YAML-style secrets (after API key patterns)
    .replace(/((?:token|password|secret|api[_-]?key)=)(?!<redacted)[^\s]+/gi, "$1<redacted>")
    .replace(/((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)(?!<redacted)[^"'\s,}]+/gi, "$1<redacted>")
    // Shell variable assignments with secrets
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|A2A_TOKEN)=)['"]?[^'"\s]+['"]?/gi, "$1<redacted>");
}

export function redactAndBound(value: string, limit = RESULT_STREAM_LIMIT): string {
  const redacted = redactSecrets(value);
  if (redacted.length <= limit) return redacted;
  const omitted = redacted.length - limit;
  return `${redacted.slice(0, limit)}\n<truncated ${omitted} chars>`;
}

export function buildResultSummary(
  completed: SpawnResult,
  stdout: string,
  stderr: string,
  artifacts: string[],
  manifest: ArtifactManifest,
  runnerBuild?: RunnerConfig["buildMetadata"],
): ResultSummary {
  return {
    exitCode: completed.code,
    signal: completed.signal,
    timedOut: completed.timedOut,
    stdout,
    stderr,
    stdoutTruncated: stdout.includes("\n<truncated "),
    stderrTruncated: stderr.includes("\n<truncated "),
    artifactCount: artifacts.length,
    manifestPath: manifest.manifestPath,
    status: manifest.status,
    ...(manifest.budget ? { budget: manifest.budget } : {}),
    ...(manifest.receiptTrace ? { receiptTrace: manifest.receiptTrace } : {}),
    ...(manifest.continuation ? { continuation: manifest.continuation } : {}),
    ...(manifest.evidenceHints ? { evidenceHints: manifest.evidenceHints } : {}),
    ...(runnerBuild ? { runnerBuild } : {}),
  };
}

export interface ArtifactManifestContext {
  task?: NormalizedRunnerTask;
  status?: ArtifactManifestStatus;
  stdout?: string;
  stderr?: string;
  prUrl?: string;
  budget?: RunnerBudgetEvidence;
  receiptTrace?: RunnerReceiptTrace;
  continuation?: RunnerContinuationEvidence;
  evidenceHints?: RunnerEvidenceHints;
}

export async function buildArtifactManifest(workDir: string, artifacts: string[], context: ArtifactManifestContext = {}): Promise<ArtifactManifest> {
  const entries: ArtifactManifestEntry[] = [];
  for (const artifact of artifacts) {
    const info = await stat(artifact);
    entries.push({
      path: relative(workDir, artifact).split("/").join("/"),
      name: basename(artifact),
      sizeBytes: info.size,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const evidence = await buildArtifactEvidenceParts(workDir, entries, context.status);
  const task = context.task;
  const primaryRepo = task?.repos.find((repo) => repo.primary) ?? task?.repos[0];
  const summary = buildArtifactManifestSummary(context, evidence.length);
  return {
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "artifacts/manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(task?.id ? { taskId: task.id } : {}),
    ...(primaryRepo?.url ? { repo: primaryRepo.url } : task?.repo ? { repo: task.repo } : {}),
    ...(primaryRepo?.branch ?? task?.baseBranch ? { branch: primaryRepo?.branch ?? task?.baseBranch } : {}),
    ...(context.prUrl ? { prUrl: context.prUrl } : task?.existingPrUrl ? { prUrl: task.existingPrUrl } : {}),
    ...(task?.issueUrl ? { issueUrl: task.issueUrl } : {}),
    status: context.status ?? "done",
    summary,
    evidence,
    artifacts: entries,
    ...(context.budget ? { budget: context.budget } : {}),
    ...(context.receiptTrace ? { receiptTrace: context.receiptTrace } : {}),
    ...(context.continuation ? { continuation: context.continuation } : {}),
    ...(context.evidenceHints ? { evidenceHints: context.evidenceHints } : {}),
  };
}

function inferBudgetStopEvidence(stdout: string, stderr: string): Pick<ArtifactManifestContext, "budget" | "continuation"> | undefined {
  const text = `${stdout}\n${stderr}`;
  if (!/(?:^|\n)(?:status=budget_limited|budget_limited\b)/i.test(text)) return undefined;

  const limitKind = extractBudgetField(text, "limitKind");
  const limit = safeBudgetText(extractBudgetField(text, "limit"));
  const used = safeBudgetText(extractBudgetField(text, "used"));
  const reason = safeBudgetText(extractBudgetField(text, "reason"));
  const budget: RunnerBudgetEvidence = {
    limitKind: isRunnerBudgetLimitKind(limitKind) ? limitKind : "time",
    ...(limit ? { limit } : {}),
    ...(used ? { used } : {}),
    ...(reason ? { reason } : {}),
  };
  const nextPrompt = safeBudgetText(extractBudgetField(text, "nextPrompt"), 300);
  return {
    budget,
    continuation: {
      recommended: true,
      requiresApproval: true,
      ...(nextPrompt ? { nextPrompt } : {}),
    },
  };
}

function parseReceiptTraceEnv(env: Record<string, string> | undefined): unknown {
  const raw = env?.A2A_RUNNER_RECEIPT_TRACE ?? env?.A2A_RECEIPT_TRACE;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return { status: "failed", reason: "invalid receipt trace metadata" };
  }
}

export function sanitizeReceiptTrace(input: unknown): RunnerReceiptTrace | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const trace: RunnerReceiptTrace = { schemaVersion: "a2a.runner.receipt-trace.v1" };
  copyReceiptText(trace, value, "outboxId", 160);
  copyReceiptText(trace, value, "notificationId", 160);
  copyReceiptText(trace, value, "dedupeKey", 240);
  copyReceiptText(trace, value, "channel", 60);
  copyReceiptText(trace, value, "receiptId", 160);
  copyReceiptText(trace, value, "acknowledgedAt", 80);
  copyReceiptText(trace, value, "updatedAt", 80);
  copyReceiptText(trace, value, "reason", 300);

  const status = typeof value.status === "string" ? value.status : undefined;
  if (isReceiptTraceStatus(status)) trace.status = status;
  const evidence = typeof value.evidence === "string" ? value.evidence : undefined;
  if (isReceiptEvidence(evidence)) trace.evidence = evidence;
  if (typeof value.attemptCount === "number" && Number.isInteger(value.attemptCount) && value.attemptCount >= 0) trace.attemptCount = value.attemptCount;
  if (typeof value.staleAfterMs === "number" && Number.isFinite(value.staleAfterMs) && value.staleAfterMs >= 0) trace.staleAfterMs = Math.floor(value.staleAfterMs);

  return Object.keys(trace).length > 1 ? trace : undefined;
}

function copyReceiptText(target: RunnerReceiptTrace, source: Record<string, unknown>, key: keyof RunnerReceiptTrace, limit: number): void {
  const value = source[key];
  if (typeof value !== "string") return;
  const safe = safeBudgetText(value, limit);
  if (safe) Object.assign(target, { [key]: safe });
}

function isReceiptTraceStatus(value: string | undefined): value is NonNullable<RunnerReceiptTrace["status"]> {
  return value === "pending"
    || value === "accepted"
    || value === "started"
    || value === "produced"
    || value === "provider_sent"
    || value === "operator_visible"
    || value === "operator_confirmed"
    || value === "provider_delivery_receipt"
    || value === "timed_out"
    || value === "stale"
    || value === "failed"
    || value === "receipt_confirmed";
}

function isReceiptEvidence(value: string | undefined): value is NonNullable<RunnerReceiptTrace["evidence"]> {
  return value === "operator_visible" || value === "operator_confirmed" || value === "provider_delivery_receipt";
}

function extractBudgetField(text: string, field: "limitKind" | "limit" | "used" | "reason" | "nextPrompt"): string | undefined {
  const aliases: Record<typeof field, string[]> = {
    limitKind: ["budget.limitKind", "budget_limit_kind"],
    limit: ["budget.limit", "budget_limit"],
    used: ["budget.used", "budget_used"],
    reason: ["budget.reason", "budget_reason"],
    nextPrompt: ["continuation.nextPrompt", "continuation_next_prompt"],
  };
  for (const alias of aliases[field]) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`(?:^|\\n)${escaped}=([^\\r\\n]+)`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function isRunnerBudgetLimitKind(value: string | undefined): value is RunnerBudgetEvidence["limitKind"] {
  return value === "time" || value === "token" || value === "attempt" || value === "command" || value === "safety";
}

function safeBudgetText(value: string | undefined, limit = 160): string | undefined {
  if (!value) return undefined;
  const safe = redactAndBound(value.replace(/[\r\n]+/g, " ").trim(), limit);
  return safe || undefined;
}

async function buildArtifactEvidenceParts(
  workDir: string,
  entries: ArtifactManifestEntry[],
  runStatus: ArtifactManifestStatus = "done",
): Promise<ArtifactEvidencePart[]> {
  const parts: ArtifactEvidencePart[] = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    const kind = lower.endsWith(".diff") || lower.endsWith(".patch")
      ? "diff"
      : lower.includes("test") || lower.includes("check")
        ? "test"
        : lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".md")
          ? "log"
          : "file";
    parts.push({
      kind,
      label: entry.name,
      status: kind === "test" ? (runStatus === "done" ? "passed" : "failed") : runStatus === "blocked" ? "blocked" : "unknown",
      path: entry.path,
      ...(await readArtifactExcerpt(workDir, entry.path)),
    });
  }
  return parts;
}

async function readArtifactExcerpt(workDir: string, relativePath: string): Promise<Pick<ArtifactEvidencePart, "excerpt">> {
  try {
    const content = await readFile(join(workDir, relativePath), "utf8");
    const excerpt = redactAndBound(content.trim(), 600);
    return excerpt ? { excerpt } : {};
  } catch {
    return {};
  }
}

function buildArtifactManifestSummary(context: ArtifactManifestContext, evidenceCount: number): string {
  if (context.prUrl) return `Runner produced PR evidence: ${context.prUrl}`;
  const status = context.status ?? "done";
  const stream = [context.stdout, context.stderr]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (stream) return stream.slice(0, 240);
  return `Runner ${status} with ${evidenceCount} evidence part${evidenceCount === 1 ? "" : "s"}.`;
}

async function writeArtifactManifest(workDir: string, manifest: ArtifactManifest): Promise<void> {
  const path = join(workDir, "artifacts", "manifest.json");
  await mkdir(join(workDir, "artifacts"), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}


function buildActionableError(engine: string, image: string, completed: SpawnResult): string {
  const combined = redactSecrets([completed.stderr, completed.stdout].filter(Boolean).join("\n")).trim();
  if (completed.errorCode === "ENOENT") {
    return `${engine} 실행 파일을 찾을 수 없습니다. Docker 또는 Podman을 설치하거나 A2A_DOCKER_RUNNER_ENGINE을 사용 가능한 엔진으로 설정하세요.`;
  }
  if (completed.timedOut) {
    return `컨테이너 실행이 제한 시간 안에 끝나지 않았습니다. timeoutMs를 늘리거나 작업 명령을 줄이고, 남은 컨테이너가 있으면 '${engine} ps -a --filter label=a2a.task.id=<safeTaskId>'로 확인한 뒤 run별 container name을 지정해 정리하세요.\n${combined}`.trim();
  }
  if (/Conflict\.? The container name|container name .* is already in use|name is already in use|already exists/i.test(combined)) {
    return `컨테이너 이름 충돌이 발생했습니다. runner는 task id와 run token을 포함한 고유 이름을 사용하므로, 같은 safeTaskId를 가진 오래된 컨테이너가 남았는지 '${engine} ps -a --filter label=a2a.task.id=<safeTaskId>'로 확인하고 해당 run만 정리하세요.\n${combined}`.trim();
  }
  if (/pull access denied|manifest unknown|not found|no such image|repository does not exist/i.test(combined)) {
    return `이미지 '${image}'를 가져오거나 찾을 수 없습니다. 이미지 이름/태그와 registry 인증을 확인하세요.\n${combined}`.trim();
  }
  if (/mkdir .*permission denied|EACCES|EROFS|read-only file system|permission denied.*work/i.test(combined)) {
    return `작업 디렉터리 생성 또는 마운트 권한 문제가 감지되었습니다. rootDir 소유권/권한과 컨테이너 볼륨 마운트 정책을 확인하고, 같은 task id의 run 디렉터리가 동시에 사용 중인지 확인하세요.\n${combined}`.trim();
  }
  if (/permission denied|cannot connect to the docker daemon|got permission denied|operation not permitted|rootless/i.test(combined)) {
    return `${engine} 실행 권한 또는 daemon 연결 권한이 없습니다. runner 사용자 권한, socket 접근, rootless Podman 설정을 확인하세요.\n${combined}`.trim();
  }
  return combined || `${engine} 실행이 실패했습니다(exit=${completed.code ?? "null"}, signal=${completed.signal ?? "none"}).`;
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
}

function spawnWithTimeout(command: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        signal: null,
        stdout: "",
        stderr: redactSecrets(error.message),
        timedOut,
        errorCode: error.code,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut });
    });
  });
}

async function listArtifacts(workDir: string): Promise<string[]> {
  const dir = join(workDir, "artifacts");
  try {
    const entries = await readdir(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry);
      if ((await stat(path)).isFile()) files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

function extractPrUrl(stdout: string): string | undefined {
  return stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
}
