import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { GitHubEvidence, NormalizedRunnerTask, RunnerConfig, RunnerResult } from "./types.js";

/**
 * Collect structured GitHub evidence after a runner task completes.
 *
 * Modes:
 * - "github-propose-patch": inspect stdout for PR URLs;
 *   on failure/blockage, post a Block comment to the linked GitHub issue.
 * - "github-verify": post Done/Block evidence for test-only verification runs.
 * - Other / absent: no-op (returns undefined evidence).
 */
export async function collectGitHubEvidence(
  config: RunnerConfig,
  task: NormalizedRunnerTask,
  result: RunnerResult,
): Promise<GitHubEvidence | undefined> {
  if (!isGitHubEvidenceMode(task.mode)) return undefined;

  const evidence: GitHubEvidence = buildBaseEvidence(task, result);

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
      evidence.blockUrl = evidence.blockCommentUrl;
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
      evidence.doneUrl = evidence.doneCommentUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[github-evidence] done-comment failed: ${msg}`);
    }
  }

  evidence.outcome = classifyGitHubEvidenceOutcome(result, evidence);
  const validationErrors = validateReleaseGateEvidence(evidence);
  if (validationErrors.length > 0) {
    evidence.validationErrors = validationErrors;
    if (evidence.outcome === "pr" || evidence.outcome === "done" || evidence.outcome === "block") {
      evidence.outcome = "missing_evidence";
    }
  }

  return evidence;
}

function classifyGitHubEvidenceOutcome(result: RunnerResult, evidence: GitHubEvidence): GitHubEvidence["outcome"] {
  if (evidence.prUrl) return "pr";
  if (evidence.blockUrl || evidence.blockCommentUrl) return "block";
  if (evidence.doneUrl || evidence.doneCommentUrl) return "done";
  if (result.resultSummary?.status === "budget_limited" || result.artifactManifest?.status === "budget_limited") return "budget_limited";
  if (result.resultSummary?.timedOut === true || result.status === "timeout") return "timed_out";
  return "missing_evidence";
}

function validateReleaseGateEvidence(evidence: GitHubEvidence): string[] {
  if (evidence.outcome !== "pr" && evidence.outcome !== "done" && evidence.outcome !== "block") return [];

  const errors: string[] = [];
  const requiredText: Array<[keyof GitHubEvidence, string | undefined]> = [
    ["taskId", evidence.taskId],
    ["worker", evidence.worker],
    ["repo", evidence.repo],
    ["issue", evidence.issue],
  ];
  for (const [field, value] of requiredText) {
    if (!isSafeStructuredText(value)) errors.push(`missing_or_unsafe_${String(field)}`);
  }
  if (!isSafeStructuredText(evidence.issueTitle) && !isSafeStructuredText(evidence.taskBrief)) {
    errors.push("missing_or_unsafe_issue_title_or_task_brief");
  }
  if (!isSafeGitHubEvidenceUrl(evidence.issueUrl)) errors.push("missing_or_unsafe_issue_url");
  if (!evidence.validation) errors.push("missing_validation_summary");
  if (!hasExplicitNoAckSafetyState(evidence)) errors.push("missing_or_unsafe_no_live_no_ack_safety_state");
  if (evidence.runId && !isSafeStructuredText(evidence.runId)) errors.push("unsafe_runId");
  if (evidence.traceId && !isSafeStructuredText(evidence.traceId)) errors.push("unsafe_traceId");

  const url = evidence.prUrl ?? evidence.doneUrl ?? evidence.doneCommentUrl ?? evidence.blockUrl ?? evidence.blockCommentUrl;
  if (!isSafeGitHubEvidenceUrl(url)) errors.push("missing_or_unsafe_terminal_url");
  return errors;
}

function hasExplicitNoAckSafetyState(evidence: GitHubEvidence): boolean {
  return evidence.safetyState?.noLiveProviderSend === true
    && evidence.safetyState.providerSendIsReceiptEvidence === false
    && (evidence.safetyState.terminalAck === "not_attempted" || evidence.safetyState.terminalAck === "requires_operator_receipt");
}

function isSafeStructuredText(value: string | undefined): boolean {
  return Boolean(value && value.trim() && value.length <= 300 && !/[\r\n]/.test(value) && !hasUnsafeEvidenceContent(value));
}

function isSafeGitHubEvidenceUrl(value: string | undefined): boolean {
  if (!value || hasUnsafeEvidenceContent(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

function hasUnsafeEvidenceContent(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Authorization:\s*(?:Bearer|token)|\/root\/|\/home\/|\/tmp\/|\/var\/folders\/|token=|password=|secret=|api[_-]?key=)/i.test(value);
}

function buildBaseEvidence(task: NormalizedRunnerTask, result: RunnerResult): GitHubEvidence {
  const validation = result.resultSummary;
  return {
    schemaVersion: "a2a.runner.github-evidence.v1",
    repo: normalizeRepo(task),
    issue: normalizeIssue(task),
    issueUrl: normalizeIssueUrl(task),
    taskId: task.id,
    worker: safeOptionalText(task.requestedBy, 80),
    issueTitle: safeOptionalText(task.issueTitle, 160),
    taskBrief: safeOptionalText(task.taskBrief ?? task.prompt, 240),
    outcome: "missing_evidence",
    validation: {
      status: result.status,
      exitCode: validation?.exitCode ?? result.exitCode,
      signal: validation?.signal ?? result.signal,
      timedOut: validation?.timedOut ?? result.status === "timeout",
      artifactCount: validation?.artifactCount ?? result.artifacts.length,
      stdoutTruncated: validation?.stdoutTruncated,
      stderrTruncated: validation?.stderrTruncated,
    },
    safetyState: {
      noLiveProviderSend: true,
      terminalAck: "requires_operator_receipt",
      providerSendIsReceiptEvidence: false,
    },
    runId: safeOptionalText(task.runId ?? task.env?.A2A_RUN_ID ?? task.env?.RUN_ID, 120),
    traceId: safeOptionalText(task.traceId ?? task.env?.A2A_TRACE_ID ?? task.env?.TRACE_ID, 120),
    branch: extractBranch(result),
    commit: extractCommit(result),
  };
}

function normalizeRepo(task: NormalizedRunnerTask): string | undefined {
  const repo = task.repo ?? task.repos.find((candidate) => candidate.primary)?.url ?? task.repos[0]?.url;
  if (!repo) return undefined;
  const slug = parseGitHubRepoSlug(repo);
  return slug ?? repo;
}

function normalizeIssue(task: NormalizedRunnerTask): string | undefined {
  if (task.issueUrl) {
    const match = task.issueUrl.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    if (match) return `${match[1]}#${match[2]}`;
    return task.issueUrl;
  }
  const raw = task.issue ?? task.issueNumber;
  if (raw == null) return undefined;
  const text = String(raw);
  const match = text.match(/#?(\d+)/);
  const repo = normalizeRepo(task);
  return repo && match ? `${repo}#${match[1]}` : text;
}

function normalizeIssueUrl(task: NormalizedRunnerTask): string | undefined {
  if (task.issueUrl && isSafeGitHubEvidenceUrl(task.issueUrl)) return task.issueUrl;
  const repo = normalizeRepo(task);
  const raw = task.issue ?? task.issueNumber;
  const issueNumber = raw == null ? undefined : String(raw).match(/#?(\d+)/)?.[1];
  return repo && issueNumber ? `https://github.com/${repo}/issues/${issueNumber}` : undefined;
}

function extractBranch(result: RunnerResult): string | undefined {
  return extractFirstMatch(result, [
    /(?:^|\n)branch=([^\s]+)/,
    /Switched to a new branch ['"]([^'"]+)['"]/,
  ]);
}

function extractCommit(result: RunnerResult): string | undefined {
  return extractFirstMatch(result, [
    /(?:^|\n)(?:commit|sha)=([a-f0-9]{7,40})(?:\s|$)/i,
    /\[[^\]\n]+\s+([a-f0-9]{7,40})\]/i,
  ]);
}

function extractFirstMatch(result: RunnerResult, patterns: RegExp[]): string | undefined {
  const text = `${result.stdout}\n${result.stderr}`;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return sanitizeCommentText(match[1]).slice(0, 200);
  }
  return undefined;
}

function isMissingPatchCommand(result: RunnerResult): boolean {
  return [result.stdout, result.stderr]
    .flatMap((text) => text.split(/\r?\n/).map((line) => line.trim()))
    .some((line) => line === "notice=no_patch_command_configured" || line === "error=no_patch_command_configured");
}

function isGitHubEvidenceMode(mode?: string): boolean {
  return mode === "github-propose-patch" || mode === "propose_patch" || mode === "github-verify";
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
  const issueUrl = normalizeIssueUrl(task) ?? "N/A";
  const validationLines = buildValidationSummaryLines(result, lang);
  const safetyLines = buildNoLiveNoAckSafetyLines(lang);

  if (lang === "ko") {
    return [
      "## 🚫 Block",
      "",
      `**요청 노드**: ${requestedBy}`,
      `**Task ID**: \`${task.id}\``,
      `**Issue URL**: ${issueUrl}`,
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
      "### Validation",
      ...validationLines,
      "",
      "### 안전 상태",
      ...safetyLines,
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
    `**Issue URL**: ${issueUrl}`,
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
    "### Validation",
    ...validationLines,
    "",
    "### Safety state",
    ...safetyLines,
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
  const issueUrl = normalizeIssueUrl(task) ?? "N/A";
  const validationLines = buildValidationSummaryLines(result, lang);
  const safetyLines = buildNoLiveNoAckSafetyLines(lang);

  if (lang === "ko") {
    return [
      "## ✅ Done",
      "",
      `**요청 노드**: ${requestedBy}`,
      `**Task ID**: \`${task.id}\``,
      `**Issue URL**: ${issueUrl}`,
      `**상태**: ${result.status} (PR URL 없음 — no-op 또는 PR 생성 불필요 태스크)`,
      ...(existingPr ? [existingPr] : []),
      "",
      "### 결과",
      "작업은 완료됐지만 PR URL은 감지되지 않았습니다. no-op 또는 PR 생성이 필요 없는 태스크로 처리합니다.",
      "",
      "### 다음 조치",
      "필요 시 아래 아티팩트와 명령 로그 요약을 확인하세요.",
      "",
      "### Validation",
      ...validationLines,
      "",
      "### 안전 상태",
      ...safetyLines,
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
    `**Issue URL**: ${issueUrl}`,
    `**Status**: ${result.status} (no PR URL — no-op or PR-less task)`,
    ...(existingPr ? [existingPr] : []),
    "",
    "### Result",
    "The task completed, but no PR URL was detected. Treating as no-op or PR-less completion.",
    "",
    "### Next action",
    "Review the artifact and command log summaries below if needed.",
    "",
    "### Validation",
    ...validationLines,
    "",
    "### Safety state",
    ...safetyLines,
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

function buildValidationSummaryLines(result: RunnerResult, lang: string): string[] {
  const summary = result.resultSummary;
  return [
    `- status: \`${result.status}\``,
    `- exitCode: ${summary?.exitCode ?? result.exitCode ?? "N/A"}`,
    `- signal: ${summary?.signal ?? result.signal ?? "N/A"}`,
    `- timedOut: ${summary?.timedOut ?? result.status === "timeout"}`,
    `- artifactCount: ${summary?.artifactCount ?? result.artifacts.length}`,
    `- stdoutTruncated: ${summary?.stdoutTruncated ?? false}`,
    `- stderrTruncated: ${summary?.stderrTruncated ?? false}`,
    lang === "ko"
      ? "- validation source: runner result summary / command exit metadata"
      : "- validation source: runner result summary / command exit metadata",
  ];
}

function buildNoLiveNoAckSafetyLines(lang: string): string[] {
  if (lang === "ko") {
    return [
      "- noLiveProviderSend: `true` (라이브 Telegram/provider 전송 없음)",
      "- terminalAck: `requires_operator_receipt` (operator-visible receipt 전까지 ACK 금지)",
      "- providerSendIsReceiptEvidence: `false` (provider send 성공은 receipt/ACK 증거가 아님)",
    ];
  }
  return [
    "- noLiveProviderSend: `true` (no live Telegram/provider send)",
    "- terminalAck: `requires_operator_receipt` (no terminal-outbox ACK before operator-visible receipt)",
    "- providerSendIsReceiptEvidence: `false` (provider send success is not receipt/ACK evidence)",
  ];
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

function safeOptionalText(value: string | undefined, maxLen: number): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeCommentText(value).replace(/\s+/g, " ").trim();
  if (!sanitized) return undefined;
  if (sanitized.length <= maxLen) return sanitized;
  const suffix = " ... truncated";
  const headLen = Math.max(1, maxLen - suffix.length);
  return `${sanitized.slice(0, headLen).trimEnd()}${suffix}`;
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
