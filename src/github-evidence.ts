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

  // If blocked (non-ok) or the default GitHub pipeline had no coding-agent
  // command configured, post a Block comment. A missing patch command is an
  // operator/runtime readiness failure, not a successful no-op.
  if ((!result.ok || missingPatchCommand) && task.issueUrl) {
    try {
      evidence.blockCommentUrl = await postBlockComment(config, task, result);
    } catch (err) {
      evidence.blockCommentUrl = undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[github-evidence] block-comment failed: ${msg}`);
    }
  }

  // If ok but no PR URL and issueUrl provided: post a Done comment.
  // Missing patch-command readiness is handled as Block above, so it never
  // becomes a misleading Done comment.
  if (result.ok && !evidence.prUrl && !evidence.blockCommentUrl && task.issueUrl) {
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
  return result.stdout.includes("notice=no_patch_command_configured")
    || result.stderr.includes("notice=no_patch_command_configured")
    || result.stdout.includes("Set commandScript or commandJson in RunnerConfig to inject a coding agent.")
    || result.stderr.includes("Set commandScript or commandJson in RunnerConfig to inject a coding agent.");
}

function isGitHubEvidenceMode(mode?: string): boolean {
  return mode === "github-propose-patch" || mode === "propose_patch";
}

/**
 * Extract an oauth token from a gh hosts.yml file.
 * Supports the standard `github.com: oauth_token: ghp_xxx` format.
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
function buildBlockCommentBody(task: NormalizedRunnerTask, result: RunnerResult): string {
  const lang = task.reportLanguage ?? "ko";
  const requestedBy = task.requestedBy ?? "a2a-broker";

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
      isMissingPatchCommand(result)
        ? "GitHub patch task reached the default pipeline, but no coding-agent patch command was configured. Configure `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` or `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` and retry."
        : result.error
        ? `\`\`\`\n${truncate(result.error, 2000)}\n\`\`\``
        : `Runner task failed with status \`${result.status}\`.`,
      "",
      "### 아티팩트",
      ...result.artifacts.map((a) => `- \`${a}\``),
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
    isMissingPatchCommand(result)
      ? "GitHub patch task reached the default pipeline, but no coding-agent patch command was configured. Configure `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` or `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` and retry."
      : result.error
      ? `\`\`\`\n${truncate(result.error, 2000)}\n\`\`\``
      : `Runner task failed with status \`${result.status}\`.`,
    "",
    "### Artifacts",
    ...result.artifacts.map((a) => `- \`${a}\``),
    "",
    "> Auto-generated Block comment — A2A Docker Runner",
  ].join("\n");
}

/**
 * Build a Done comment body.
 */
function buildDoneCommentBody(task: NormalizedRunnerTask, result: RunnerResult): string {
  const lang = task.reportLanguage ?? "ko";
  const requestedBy = task.requestedBy ?? "a2a-broker";

  if (lang === "ko") {
    return [
      "## ✅ Done",
      "",
      `**요청 노드**: ${requestedBy}`,
      `**Task ID**: \`${task.id}\``,
      `**상태**: ${result.status} (PR URL 없음 — no-op 또는 PR 생성 불필요 태스크)`,
      ...(result.artifacts.length ? ["", "### 아티팩트", ...result.artifacts.map((a) => `- \`${a}\``)] : []),
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
    ...(result.artifacts.length ? ["", "### Artifacts", ...result.artifacts.map((a) => `- \`${a}\``)] : []),
    "",
    "> Auto-generated Done comment — A2A Docker Runner",
  ].join("\n");
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n... (truncated)";
}
