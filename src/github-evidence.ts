import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { GitHubEvidence, NormalizedRunnerTask, RunnerConfig, RunnerResult } from "./types.js";

/**
 * Collect structured GitHub evidence after a runner task completes.
 *
 * Modes:
 * - "github-propose-patch": inspect stdout for PR URLs;
 *   on failure/blockage, post a Block comment to the linked GitHub issue.
 * - Other / absent: no-op (returns undefined evidence).
 */
export async function collectGitHubEvidence(
  config: RunnerConfig,
  task: NormalizedRunnerTask,
  result: RunnerResult,
): Promise<GitHubEvidence | undefined> {
  if (!isGitHubEvidenceMode(task.mode)) return undefined;

  const evidence: GitHubEvidence = {};

  // On success: extract PR URL from stdout (also check artifacts).
  if (result.prUrl) {
    evidence.prUrl = result.prUrl;
  }

  const missingPatchCommand = isMissingPatchCommand(result);
  const missingExecutableWork = task.commands.length === 0;

  // If blocked (non-ok), the default GitHub pipeline had no coding-agent
  // command configured, or normalization produced no commands at all, post a
  // Block comment. Missing executable work is an operator/runtime readiness
  // failure, not a successful no-op.
  if ((!result.ok || missingPatchCommand || missingExecutableWork) && task.issueUrl) {
    try {
      evidence.blockCommentUrl = await postBlockComment(config, task, result);
    } catch (err) {
      evidence.blockCommentUrl = undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[github-evidence] block-comment failed: ${msg}`);
    }
  }

  // If ok but no PR URL and issueUrl provided: post a Done comment.
  // Missing executable work/readiness is handled as Block above, so it never
  // becomes a misleading Done comment.
  if (result.ok && !missingExecutableWork && !evidence.prUrl && !evidence.blockCommentUrl && task.issueUrl) {
    try {
      evidence.doneCommentUrl = await postDoneComment(config, task, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[github-evidence] done-comment failed: ${msg}`);
    }
  }

  return evidence;
}

function isMissingPatchCommand(result: RunnerResult): boolean {
  return [result.stdout, result.stderr]
    .flatMap((text) => text.split(/\r?\n/).map((line) => line.trim()))
    .some((line) => line === "notice=no_patch_command_configured" || line === "error=no_patch_command_configured");
}

function isGitHubEvidenceMode(mode?: string): boolean {
  return mode === "github-propose-patch" || mode === "propose_patch";
}

/**
 * Extract an oauth token from a gh hosts.yml file.
 * Supports the standard `github.com: oauth_token: <github-token>` format.
 */
async function readGitHubToken(config: RunnerConfig): Promise<string | undefined> {
  const file = config.githubTokenFile;
  if (!file || !existsSync(file)) return undefined;

  try {
    const contents = await readFile(file, "utf8");
    const match = contents.match(/oauth_token:\s*(\S+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Post a Block comment on the GitHub issue.
 *
 * Comment format explains why the task is blocked, includes runner
 * evidence (exit code, signal, error summary), and identifies the
 * requesting node.
 */
async function postBlockComment(
  config: RunnerConfig,
  task: NormalizedRunnerTask,
  result: RunnerResult,
): Promise<string | undefined> {
  const token = await readGitHubToken(config);
  if (!token) {
    console.error("[github-evidence] no GitHub token available; cannot post block comment");
    return undefined;
  }

  const issueCommentUrl = parseIssueCommentApiUrl(task.issueUrl);
  if (!issueCommentUrl) {
    console.error(`[github-evidence] cannot parse issue URL: ${task.issueUrl}`);
    return undefined;
  }

  const body = buildBlockCommentBody(task, result);
  const response = await fetch(issueCommentUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as { html_url?: string };
  return data.html_url;
}

/**
 * Post a Done comment on the GitHub issue.
 *
 * Used when the task succeeded but didn't produce a PR URL
 * (e.g. a no-op patch where no changes were generated).
 */
async function postDoneComment(
  config: RunnerConfig,
  task: NormalizedRunnerTask,
  result: RunnerResult,
): Promise<string | undefined> {
  const token = await readGitHubToken(config);
  if (!token) {
    console.error("[github-evidence] no GitHub token available; cannot post done comment");
    return undefined;
  }

  const issueCommentUrl = parseIssueCommentApiUrl(task.issueUrl);
  if (!issueCommentUrl) {
    console.error(`[github-evidence] cannot parse issue URL: ${task.issueUrl}`);
    return undefined;
  }

  const body = buildDoneCommentBody(task, result);
  const response = await fetch(issueCommentUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as { html_url?: string };
  return data.html_url;
}

/**
 * Parse a GitHub issue URL into the API endpoint for issue comments.
 *
 * Input:  https://github.com/jinwon-int/a2a-docker-runner/issues/5
 * Output: https://api.github.com/repos/jinwon-int/a2a-docker-runner/issues/5/comments
 */
function parseIssueCommentApiUrl(issueUrl: string | undefined): string | undefined {
  if (!issueUrl) return undefined;
  const match = issueUrl.match(
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/,
  );
  if (!match) return undefined;
  return `https://api.github.com/repos/${match[1]}/issues/${match[2]}/comments`;
}

/**
 * Build a Block comment body in the appropriate language.
 *
 * Korean default; falls back with English prefix when reportLanguage is not "ko".
 */
export function buildBlockCommentBody(task: NormalizedRunnerTask, result: RunnerResult): string {
  const lang = task.reportLanguage ?? "ko";
  const requestedBy = task.requestedBy ?? "a2a-broker";
  const reason = buildReason(task, result);
  const action = buildAction(task, result, lang);
  const artifactLines = buildArtifactSummaryLines(result, lang);
  const buildLines = buildRunnerBuildLines(result, lang);
  const commandLogLines = buildCommandLogLines(result, lang);

  if (lang === "ko") {
    return [
      "## 🚫 Block",
      "",
      `**요청 노드**: ${requestedBy}`,
      `**Task ID**: \`${task.id}\``,
      `**상태**: ${result.status}`,
      `**종료 코드**: ${result.exitCode ?? "N/A"}`,
      ...(result.signal ? [`**시그널**: ${result.signal}`] : []),
      "",
      "### 사유",
      reason,
      "",
      "### 다음 조치",
      action,
      "",
      "### 아티팩트 manifest 요약",
      ...artifactLines,
      "",
      "### Runner build",
      ...buildLines,
      "",
      "### 명령 로그 요약",
      ...commandLogLines,
      "",
      "> 자동 생성된 Block 코멘트 — A2A Docker Runner",
    ].join("\n");
  }

  return [
    "## 🚫 Block",
    "",
    `**Requested by**: ${requestedBy}`,
    `**Task ID**: \`${task.id}\``,
    `**Status**: ${result.status}`,
    `**Exit code**: ${result.exitCode ?? "N/A"}`,
    ...(result.signal ? [`**Signal**: ${result.signal}`] : []),
    "",
    "### Reason",
    reason,
    "",
    "### Next action",
    action,
    "",
    "### Artifact manifest summary",
    ...artifactLines,
    "",
    "### Runner build",
    ...buildLines,
    "",
    "### Command log summary",
    ...commandLogLines,
    "",
    "> Auto-generated Block comment — A2A Docker Runner",
  ].join("\n");
}

/**
 * Build a Done comment body.
 */
export function buildDoneCommentBody(task: NormalizedRunnerTask, result: RunnerResult): string {
  const lang = task.reportLanguage ?? "ko";
  const requestedBy = task.requestedBy ?? "a2a-broker";
  const artifactLines = buildArtifactSummaryLines(result, lang);
  const buildLines = buildRunnerBuildLines(result, lang);
  const commandLogLines = buildCommandLogLines(result, lang);
  const existingPr = buildExistingPrLine(task, lang);

  if (lang === "ko") {
    return [
      "## ✅ Done",
      "",
      `**요청 노드**: ${requestedBy}`,
      `**Task ID**: \`${task.id}\``,
      `**상태**: ${result.status} (PR URL 없음 — no-op 또는 PR 생성 불필요 태스크)`,
      ...(existingPr ? [existingPr] : []),
      "",
      "### 결과",
      "작업은 완료됐지만 PR URL은 감지되지 않았습니다. no-op 또는 PR 생성이 필요 없는 태스크로 처리합니다.",
      "",
      "### 다음 조치",
      "필요 시 아래 아티팩트와 명령 로그 요약을 확인하세요.",
      "",
      "### 아티팩트 manifest 요약",
      ...artifactLines,
      "",
      "### Runner build",
      ...buildLines,
      "",
      "### 명령 로그 요약",
      ...commandLogLines,
      "",
      "> 자동 생성된 Done 코멘트 — A2A Docker Runner",
    ].join("\n");
  }

  return [
    "## ✅ Done",
    "",
    `**Requested by**: ${requestedBy}`,
    `**Task ID**: \`${task.id}\``,
    `**Status**: ${result.status} (no PR URL — no-op or PR-less task)`,
    ...(existingPr ? [existingPr] : []),
    "",
    "### Result",
    "The task completed, but no PR URL was detected. Treating as no-op or PR-less completion.",
    "",
    "### Next action",
    "Review the artifact and command log summaries below if needed.",
    "",
    "### Artifact manifest summary",
    ...artifactLines,
    "",
    "### Runner build",
    ...buildLines,
    "",
    "### Command log summary",
    ...commandLogLines,
    "",
    "> Auto-generated Done comment — A2A Docker Runner",
  ].join("\n");
}

function buildExistingPrLine(task: NormalizedRunnerTask, lang: string): string | undefined {
  const existingPrUrl = task.existingPrUrl ?? buildExistingPrUrl(task);
  if (!existingPrUrl) return undefined;
  return lang === "ko" ? `**기존 PR**: ${existingPrUrl}` : `**Existing PR**: ${existingPrUrl}`;
}

function buildExistingPrUrl(task: NormalizedRunnerTask): string | undefined {
  const repo = task.repo ?? task.repos?.find((candidate) => candidate.primary)?.url ?? task.repos?.[0]?.url;
  const repoSlug = repo ? parseGitHubRepoSlug(repo) : undefined;
  const rawNumber = task.existingPrNumber != null ? String(task.existingPrNumber) : undefined;
  const prNumber = rawNumber?.match(/#?(\d+)/)?.[1];
  if (!repoSlug || !prNumber) return undefined;
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}

function parseGitHubRepoSlug(repoUrl: string): string | undefined {
  const normalized = repoUrl.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) ? `https://github.com/${repoUrl}.git` : repoUrl;
  const match = normalized.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return match?.[1];
}

function buildReason(task: NormalizedRunnerTask, result: RunnerResult): string {
  if (task.commands.length === 0) {
    return "GitHub patch task normalized to zero executable commands, so no worker actually attempted a patch. This must be treated as Block evidence instead of Done/no-op evidence.";
  }
  if (isMissingPatchCommand(result)) {
    return "GitHub patch task reached the default pipeline, but no coding-agent patch command was configured. Configure `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` or `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` and retry.";
  }
  if (result.error) return `\`\`\`\n${sanitizeCommentText(truncate(result.error, 2000))}\n\`\`\``;
  return `Runner task failed with status \`${result.status}\`.`;
}

function buildAction(task: NormalizedRunnerTask, result: RunnerResult, lang: string): string {
  if (lang !== "ko") {
    if (task.commands.length === 0) {
      return "Provide a repo/default command path or inject patch command configuration, then retry the same task.";
    }
    if (isMissingPatchCommand(result)) {
      return "Inject patch command configuration, then retry the same task.";
    }
    if (result.status === "timeout") return "Investigate the timeout and retry with adjusted timeout/resources.";
    return "Review command logs and artifacts, fix the failure cause, then retry.";
  }
  if (task.commands.length === 0) {
    return "repo/default command 경로 또는 패치 명령 설정을 제공한 뒤 동일 task를 재시도하세요.";
  }
  if (isMissingPatchCommand(result)) {
    return "패치 명령 설정을 주입한 뒤 동일 task를 재시도하세요.";
  }
  if (result.status === "timeout") return "타임아웃 원인을 확인하고 timeout/resources 조정 후 재시도하세요.";
  return "명령 로그와 아티팩트를 확인해 실패 원인을 수정한 뒤 재시도하세요.";
}

function buildArtifactSummaryLines(result: RunnerResult, lang: string): string[] {
  const manifest = result.artifactManifest;
  const entries = manifest?.artifacts ?? result.artifacts.map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path, sizeBytes: 0 }));
  const manifestPath = sanitizeArtifactPath(manifest?.manifestPath ?? result.resultSummary?.manifestPath ?? "artifacts/manifest.json");
  const none = lang === "ko" ? "- 기록된 아티팩트 없음" : "- No artifacts recorded";
  if (!entries.length) return [`- manifest: \`${manifestPath}\``, none];

  const lines = [`- manifest: \`${manifestPath}\``, `- count: ${entries.length}`];
  for (const entry of entries.slice(0, 10)) {
    const path = sanitizeArtifactPath(entry.path);
    const size = entry.sizeBytes ? ` (${entry.sizeBytes} bytes)` : "";
    lines.push(`- \`${path}\`${size}`);
  }
  if (entries.length > 10) lines.push(`- ... ${entries.length - 10} more`);
  return lines;
}

function buildRunnerBuildLines(result: RunnerResult, lang: string): string[] {
  const build = result.resultSummary?.runnerBuild ?? result.runnerBuild;
  if (!build || Object.values(build).every((value) => !value)) {
    return [lang === "ko" ? "- 주입된 runner build metadata 없음" : "- No runner build metadata injected"];
  }

  const labels: Array<[string, string | undefined]> = [
    ["version", build.version],
    ["revision", build.revision],
    ["source", build.source],
    ["builtAt", build.builtAt],
    ["image", build.image],
  ];
  return labels
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: \`${sanitizeCommentText(truncate(value!, 200))}\``);
}

function buildCommandLogLines(result: RunnerResult, lang: string): string[] {
  const summary = result.resultSummary;
  const stdout = sanitizeCommentText(summary?.stdout ?? result.stdout);
  const stderr = sanitizeCommentText(summary?.stderr ?? result.stderr);
  const lines = [
    `- exitCode: ${summary?.exitCode ?? result.exitCode ?? "N/A"}`,
    `- signal: ${summary?.signal ?? result.signal ?? "N/A"}`,
    `- timedOut: ${summary?.timedOut ?? (result.status === "timeout")}`,
  ];
  if (stdout.trim()) lines.push("- stdout:\n```text\n" + truncate(stdout, 1200) + "\n```");
  if (stderr.trim()) lines.push("- stderr:\n```text\n" + truncate(stderr, 1200) + "\n```");
  if (!stdout.trim() && !stderr.trim()) lines.push(lang === "ko" ? "- stdout/stderr 요약 없음" : "- No stdout/stderr summary");
  return lines;
}

function sanitizeArtifactPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/\/root\/\.config\/gh\/[^\s)`]+/g, "<github-config>")
    .replace(/\/root\/\.openclaw\/[^\s)`]+/g, "<openclaw-workspace>")
    .replace(/\/tmp\/[^\s)`]+/g, "<tmp-artifact>")
    .replace(/\/var\/folders\/[^\s)`]+/g, "<tmp-artifact>");
}

function sanitizeCommentText(text: string): string {
  return sanitizeArtifactPath(text)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "<redacted-github-token>")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "<redacted-github-token>")
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)[^\s]+/gi, "$1<redacted>");
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n... (truncated)";
}
