/**
 * Integration seam: openclaw-a2a-worker handler → a2a-docker-runner.
 *
 * The worker handler at /opt/openclaw-a2a-worker/handlers/openclaw-a2a-task-handler.mjs
 * calls these helpers to route github-propose-patch / propose_patch tasks into
 * container-isolated execution instead of mutating the host workspace directly.
 *
 * Broker claim/heartbeat logic is NOT touched by this module.
 */

import type { ArtifactManifest, GitHubEvidence, ResultSummary, RunnerBuildMetadata, RunnerTask } from "./types.js";

// ── Handler payload shape (what the broker sends to the worker) ────────────

export interface HandlerEnv {
  /** Enable the Docker-runner integration path. "1"/"true"/"yes"/"on". */
  A2A_DOCKER_RUNNER_ENABLED?: string;
  /** Force all github-propose-patch tasks through the runner. "1"/"true"/"yes"/"on". */
  A2A_DOCKER_RUNNER_ALL_GITHUB?: string;
  /** Preset to use when building the runner task. */
  A2A_DOCKER_RUNNER_PRESET?: string;
  /** Binary path for a2a-docker-runner. Defaults to "a2a-docker-runner". */
  A2A_DOCKER_RUNNER_BIN?: string;
  /** Extra CLI args passed before "run". JSON string array. */
  A2A_DOCKER_RUNNER_ARGS_JSON?: string;
  /** Override default task timeout (ms). */
  A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS?: string;
}

export interface HandlerTaskPayload {
  mode?: string;
  repo?: string;
  issue?: string;
  issueNumber?: string;
  issueUrl?: string;
  existingPrUrl?: string;
  existingPrNumber?: string | number;
  prUrl?: string;
  prNumber?: string | number;
  forbidNewPr?: boolean;
  noNewPr?: boolean;
  commentOnly?: boolean;
  evidenceOnly?: boolean;
  baseBranch?: string;
  title?: string;
  focus?: string;
  acceptance?: string;
  prompt?: string;
  timeoutMs?: number;
  runnerPreset?: string;
  requestedBy?: string;
  worker?: string;
  runId?: string;
  traceId?: string;
}

/** Minimal broker-task shape needed by the integration helpers. */
export interface HandlerTask {
  id?: string;
  intent?: string;
  message?: string;
  taskOrigin?: string;
  payload?: HandlerTaskPayload;
}

/** Result shape consumed by the handler after runner execution. */
export interface HandlerResult {
  status: "pr_opened" | "done" | "blocked";
  summary: string;
  prUrl?: string;
  blockCommentUrl?: string;
  doneCommentUrl?: string;
  branch?: string;
  tests: string[];
  filesChanged: string[];
  risks: string[];
  /** Compact, payload-safe Terminal Brief event for broker SSE/webhook delivery. */
  terminalEvidence: TerminalEvidenceEvent;
  /** Raw runner stdout JSON (for debugging). */
  runnerRaw?: Record<string, unknown>;
  /** Safe operator recommendation when the runner stopped at a budget limit. */
  nextAction?: string;
}

export interface OperatorTaskReportEvidence {
  schemaVersion: "a2a.runner.operator-task-report.v1";
  taskId: string;
  status: HandlerResult["status"];
  evidenceKind: TerminalEvidenceKind;
  worker: string;
  repo?: string;
  issue?: string;
  issueTitle?: string;
  taskBrief?: string;
  /** Canonical PR/Done/Block URL, when available. */
  url?: string;
  summary: string;
  tests: string[];
  risks: string[];
  runnerBuild?: RunnerBuildMetadata;
  dedupeKey: string;
}

export type TerminalEvidenceStatus = "succeeded" | "failed" | "cancelled" | "blocked";
export type TerminalEvidenceKind = "PR" | "Done" | "Block" | "BudgetLimited" | "TimedOut" | "MissingEvidence";

export interface TerminalEvidenceEvent {
  schemaVersion: "a2a.runner.terminal-evidence.v1";
  /** Stable event identity for broker replay/deduplication. */
  eventId: string;
  /** Explicit adapter idempotency key; stable across retries/replays of the same terminal outcome. */
  dedupeKey: string;
  taskId: string;
  status: TerminalEvidenceStatus;
  evidenceKind: TerminalEvidenceKind;
  worker: string;
  repo?: string;
  issue?: string;
  /** Canonical GitHub issue URL carried on Terminal Brief evidence. */
  issueUrl?: string;
  issueTitle?: string;
  taskBrief?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  /** Preformatted compact alert text for terminal notifications; never contains raw runner logs. */
  alert: {
    title: string;
    body: string;
    url?: string;
  };
  /** Short human-facing outcome reason; never contains raw runner logs. */
  reason?: string;
  testSummary: {
    label: string;
    exitCode?: number | null;
    timedOut?: boolean;
    artifactCount?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  };
  /** Explicit no-live/no-ACK state; provider send success is not receipt evidence. */
  safetyState: {
    noLiveProviderSend: true;
    terminalAck: "requires_operator_receipt";
    providerSendIsReceiptEvidence: false;
  };
  /** Bounded build/source metadata; no raw env, secrets, or host paths. */
  runnerBuild?: RunnerBuildMetadata;
  timestamps: {
    emittedAt: string;
  };
}

/** Receipt emitted by the delivery adapter after an operator-visible terminal
 * notification is actually observable (for example a Telegram message id or
 * URL). Gateway/provider send success alone is not enough to advance broker
 * ack/cursor state.
 */
export interface TerminalEvidenceReceipt {
  eventId?: string;
  dedupeKey?: string;
  providerSendOk?: boolean;
  operatorVisible?: boolean;
  channel?: string;
  messageId?: string;
  receiptUrl?: string;
  receivedAt?: string;
}

export interface TerminalEvidenceAckDecision {
  ack: boolean;
  cursorComplete: boolean;
  reason: string;
}

export interface TerminalAckReceipt {
  /** Must represent operator-visible delivery (for example broker SSE/webhook receipt), not only provider send success. */
  operatorVisible: boolean;
  channel?: string;
  receiptId?: string;
  url?: string;
  deliveredAt?: string;
}

export interface TerminalAckDecision {
  schemaVersion: "a2a.runner.terminal-ack.v1";
  eventId: string;
  taskId: string;
  evidenceKind: TerminalEvidenceKind;
  acknowledged: boolean;
  cursorComplete: boolean;
  reason: string;
  receipt?: {
    channel?: string;
    receiptId?: string;
    url?: string;
    deliveredAt?: string;
  };
}

// ── Detection helpers ──────────────────────────────────────────────────────

/**
 * Returns true when the broker task represents a github-propose-patch assignment.
 *
 * Matches either `payload.mode === "github-propose-patch"` or legacy
 * `taskOrigin === "github"`.
 */
export function isGithubProposePatchTask(task: HandlerTask): boolean {
  return task?.payload?.mode === "github-propose-patch" || task?.taskOrigin === "github";
}

/** Truthy-string check for env vars. */
export function isEnvTruthy(value?: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * Returns true when a github-propose-patch task should be routed to the
 * Docker runner instead of the legacy direct-workspace path.
 *
 * Conditions:
 * - A2A_DOCKER_RUNNER_ENABLED must be truthy.
 * - Task payload must be a github-propose-patch task.
 * - Either A2A_DOCKER_RUNNER_ALL_GITHUB is set, or the task targets a known
 *   repo/preset (openclaw-plugin-a2a, etc.).
 */
export function shouldUseDockerRunnerForGithub(
  task: HandlerTask,
  env: HandlerEnv,
): boolean {
  if (!isEnvTruthy(env.A2A_DOCKER_RUNNER_ENABLED)) return false;
  if (!isGithubProposePatchTask(task)) return false;
  if (isEnvTruthy(env.A2A_DOCKER_RUNNER_ALL_GITHUB)) return true;

  const repo = normalizeString(task?.payload?.repo) ?? "";
  const requestedPreset = normalizeString(task?.payload?.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET);
  return requestedPreset === "openclaw-plugin-a2a-dev" || /openclaw-plugin-a2a/.test(repo);
}

// ── Runner task builder ────────────────────────────────────────────────────

/**
 * Build a `RunnerTask` from the broker task payload and handler environment.
 *
 * The returned object is the canonical input for `a2a-docker-runner run task.json`.
 */
export function buildRunnerTaskFromHandlerPayload(
  task: HandlerTask,
  env: HandlerEnv,
): RunnerTask {
  const repo = normalizeString(task?.payload?.repo);
  const requestedPreset = normalizeString(
    task?.payload?.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET,
  );

  const envTimeoutMs =
    env.A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS != null ? Number(env.A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS) : NaN;
  const runnerTask: RunnerTask = {
    id: normalizeString(task?.id) ?? `task-${Date.now()}`,
    intent: normalizeString(task?.intent) ?? "propose_patch",
    mode: "github-propose-patch",
    prompt: normalizeString(task?.message ?? task?.payload?.prompt) ?? "",
    issueUrl: normalizeString(task?.payload?.issueUrl) ?? undefined,
    issueTitle: safeEvidenceText(task?.payload?.title, 160),
    taskBrief: safeEvidenceText(task?.payload?.focus ?? task?.message ?? task?.payload?.prompt, 240),
    reportLanguage: "ko",
    requestedBy: safeEvidenceText(task?.payload?.requestedBy ?? task?.payload?.worker, 80),
    runId: safeEvidenceText(task?.payload?.runId, 120),
    traceId: safeEvidenceText(task?.payload?.traceId, 120),
    existingPrUrl: normalizeExistingPrUrl(task, repo),
    existingPrNumber: task?.payload?.existingPrNumber ?? task?.payload?.prNumber,
    forbidNewPr: Boolean(task?.payload?.forbidNewPr ?? task?.payload?.noNewPr),
    commentOnly: Boolean(task?.payload?.commentOnly ?? task?.payload?.evidenceOnly),
    timeoutMs:
      !isNaN(envTimeoutMs)
        ? envTimeoutMs
        : task?.payload?.timeoutMs ?? 45 * 60 * 1000,
  };

  // ── issueUrl fallback: construct from repo + issue/issueNumber ──
  if (!runnerTask.issueUrl && repo) {
    const issueNum = extractIssueNumber(task);
    if (issueNum) {
      runnerTask.issueUrl = `https://github.com/${repo}/issues/${issueNum}`;
    }
  }

  // ── preset path (openclaw-plugin-a2a-dev, etc.) ──
  if (requestedPreset === "openclaw-plugin-a2a-dev" || (repo != null && /openclaw-plugin-a2a/.test(repo))) {
    runnerTask.preset = "openclaw-plugin-a2a-dev";
    const baseBranch = normalizeString(task?.payload?.baseBranch);
    if (baseBranch) {
      runnerTask.baseBranch = baseBranch;
    }
    return runnerTask;
  }

  // ── general repo path ──
  if (repo) {
    runnerTask.repo = repo;
    const baseBranch = normalizeString(task?.payload?.baseBranch);
    if (baseBranch) {
      runnerTask.baseBranch = baseBranch;
    }
  }

  return runnerTask;
}

// ── Runner output parsing ──────────────────────────────────────────────────

/** Raw stdout from `a2a-docker-runner run`, after JSON.parse. */
export interface RawRunnerOutput {
  ok: boolean;
  taskId: string;
  status: "completed" | "failed" | "timeout";
  workDir: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  /** Structured manifest for artifacts emitted by modern runner versions. */
  artifactManifest?: ArtifactManifest;
  /** Bounded/redacted payload-safe summary emitted by modern runner versions. */
  resultSummary?: ResultSummary;
  runnerBuild?: RunnerBuildMetadata;
  prUrl?: string;
  error?: string;
  github?: GitHubEvidence;
}

/**
 * Parse and validate the raw stdout from `a2a-docker-runner run`.
 */
export function parseRunnerOutput(raw: string): RawRunnerOutput {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("a2a-docker-runner produced no output");
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") {
    throw new Error("a2a-docker-runner output missing required fields (ok, taskId, status)");
  }
  validateBudgetContinuationContract(parsed as RawRunnerOutput);
  return parsed as RawRunnerOutput;
}

// ── GitHub evidence extraction ─────────────────────────────────────────────

/**
 * Extract structured GitHub completion evidence from raw runner output.
 *
 * Precedence: prUrl > blockCommentUrl > doneCommentUrl.
 */
export function extractGitHubEvidence(
  result: RawRunnerOutput,
): GitHubEvidence | null {
  const budgetLimited = isBudgetLimitedResult(result);
  // Runner already produced structured evidence (github property)
  if (result.github) {
    const g = result.github;
    if (g.prUrl) return { ...g, outcome: "pr", prUrl: g.prUrl, blockUrl: undefined, blockCommentUrl: undefined, doneUrl: undefined, doneCommentUrl: undefined };
    const blockUrl = g.blockUrl ?? g.blockCommentUrl;
    if (blockUrl) return { ...g, outcome: "block", blockUrl, blockCommentUrl: blockUrl };
    const doneUrl = g.doneUrl ?? g.doneCommentUrl;
    if (doneUrl && !budgetLimited && result.ok && result.status === "completed") return { ...g, outcome: "done", doneUrl, doneCommentUrl: doneUrl };
  }

  // Fallback: legacy PR URL from stdout parsing
  if (result.prUrl) return { prUrl: result.prUrl };

  return null;
}

// ── Handler result builder ─────────────────────────────────────────────────

/**
 * Build the handler-side result object from runner output.
 *
 * This is the shape the worker handler returns to the broker after
 * a Docker-runner execution.
 */
export function buildHandlerResult(
  result: RawRunnerOutput,
  task: HandlerTask,
  nodeId: string,
): HandlerResult {
  const evidence = extractGitHubEvidence(result);

  if (!evidence) {
    const budgetLimited = isBudgetLimitedResult(result);
    return {
      status: "blocked",
      summary: budgetLimited
        ? `Docker runner stopped at a budget limit; continuation approval needed — task ${task?.id ?? "unknown"}`
        : `Docker runner completed without PR/Done/Block evidence — task ${task?.id ?? "unknown"}`,
      tests: [],
      filesChanged: resultFilesChanged(result),
      risks: budgetLimited
        ? ["runner stopped because a bounded budget was exhausted", safeContinuationRecommendation(result)]
        : ["runner completed without structured GitHub evidence"],
      nextAction: budgetLimited ? safeContinuationRecommendation(result) : undefined,
      terminalEvidence: buildTerminalEvidenceEvent(result, task, nodeId),
      runnerRaw: brokerFacingRunnerRaw(result),
    };
  }

  const status = evidence.prUrl
    ? "pr_opened"
    : evidence.blockCommentUrl
      ? "blocked"
      : "done";

  return {
    status,
    summary: `Docker runner completed ${task?.id ?? "unknown task"}`,
    prUrl: evidence.prUrl,
    blockCommentUrl: evidence.blockCommentUrl,
    doneCommentUrl: evidence.doneCommentUrl,
    tests: ["a2a-docker-runner run -> completed"],
    filesChanged: resultFilesChanged(result),
    risks: evidence.prUrl ? [] : ["runner completed without PR evidence"],
    terminalEvidence: buildTerminalEvidenceEvent(result, task, nodeId),
    runnerRaw: brokerFacingRunnerRaw(result),
  };
}

export function buildTerminalEvidenceEvent(
  result: RawRunnerOutput,
  task: HandlerTask,
  nodeId: string,
  emittedAt = new Date().toISOString(),
): TerminalEvidenceEvent {
  const evidence = extractGitHubEvidence(result);
  const budgetLimited = isBudgetLimitedResult(result);
  const timedOut = result.resultSummary?.timedOut === true || result.status === "timeout";
  const evidenceKind: TerminalEvidenceKind = evidence?.prUrl
    ? "PR"
    : evidence?.doneCommentUrl && !budgetLimited
      ? "Done"
      : evidence?.blockCommentUrl
        ? "Block"
        : budgetLimited
          ? "BudgetLimited"
          : timedOut
            ? "TimedOut"
            : "MissingEvidence";
  const status: TerminalEvidenceStatus = evidenceKind === "PR" || evidenceKind === "Done"
    ? "succeeded"
    : evidenceKind === "Block" || evidenceKind === "BudgetLimited"
      ? "blocked"
      : evidenceKind === "TimedOut"
        ? "cancelled"
        : result.ok
          ? "blocked"
          : "failed";
  const url = evidence?.prUrl ?? evidence?.doneCommentUrl ?? evidence?.blockCommentUrl;
  const taskId = task?.id ?? result.taskId ?? "unknown";
  const summary = result.resultSummary;
  const worker = normalizeString(nodeId) ?? "unknown";
  const repo = normalizeString(task?.payload?.repo);
  const issue = normalizeIssueReference(task);
  const issueUrl = normalizeGitHubIssueUrl(task?.payload?.issueUrl ?? evidence?.issueUrl, repo, task?.payload?.issue ?? task?.payload?.issueNumber);
  const issueTitle = safeEvidenceText(task?.payload?.title ?? evidence?.issueTitle, 160);
  const taskBrief = safeEvidenceText(task?.payload?.focus ?? task?.message ?? task?.payload?.prompt ?? evidence?.taskBrief, 240);
  const testSummary = {
    label: buildTestSummaryLabel(result, evidenceKind),
    exitCode: summary?.exitCode ?? result.exitCode,
    timedOut: summary?.timedOut ?? result.status === "timeout",
    artifactCount: summary?.artifactCount ?? result.artifacts?.length,
    stdoutTruncated: summary?.stdoutTruncated,
    stderrTruncated: summary?.stderrTruncated,
  };
  const eventId = stableEventId(taskId, status, evidenceKind, url ?? "none");

  return {
    schemaVersion: "a2a.runner.terminal-evidence.v1",
    eventId,
    dedupeKey: eventId,
    taskId,
    status,
    evidenceKind,
    worker,
    repo,
    issue,
    issueUrl,
    issueTitle,
    taskBrief,
    prUrl: evidence?.prUrl,
    doneUrl: evidence?.doneCommentUrl,
    blockUrl: evidence?.blockCommentUrl,
    alert: buildTerminalAlert({ taskId, status, evidenceKind, worker, repo, issue, issueTitle, taskBrief, url, result, testSummary }),
    reason: buildTerminalReason(result, evidenceKind),
    testSummary,
    safetyState: {
      noLiveProviderSend: true,
      terminalAck: "requires_operator_receipt",
      providerSendIsReceiptEvidence: false,
    },
    runnerBuild: summary?.runnerBuild ?? result.runnerBuild,
    timestamps: { emittedAt },
  };
}

/**
 * Decide whether a terminal-evidence notification may be acked back to the
 * broker. This intentionally requires receipt/operator-visible evidence and
 * rejects provider-send success by itself, preventing false terminal acks.
 */
export function decideTerminalEvidenceAck(
  event: TerminalEvidenceEvent,
  receipt?: TerminalEvidenceReceipt,
): TerminalEvidenceAckDecision {
  if (!receipt) {
    return { ack: false, cursorComplete: false, reason: "missing operator-visible receipt" };
  }

  if (receipt.eventId && receipt.eventId !== event.eventId) {
    return { ack: false, cursorComplete: false, reason: "receipt eventId mismatch" };
  }

  if (receipt.dedupeKey && receipt.dedupeKey !== event.dedupeKey) {
    return { ack: false, cursorComplete: false, reason: "receipt dedupeKey mismatch" };
  }

  if (receipt.operatorVisible !== true) {
    return { ack: false, cursorComplete: false, reason: "provider send success without operator-visible receipt" };
  }

  if (!normalizeString(receipt.messageId) && !normalizeString(receipt.receiptUrl)) {
    return { ack: false, cursorComplete: false, reason: "operator-visible receipt lacks message id/url" };
  }

  return { ack: true, cursorComplete: true, reason: "operator-visible receipt confirmed" };
}

/**
 * Decide whether a compact terminal evidence event may advance the broker
 * terminal ack/cursor. Gateway/provider send success is intentionally not
 * enough: the caller must pass an operator-visible delivery receipt.
 */
export function buildOperatorTaskReportEvidence(result: HandlerResult): OperatorTaskReportEvidence {
  const event = result.terminalEvidence;
  return omitUndefined({
    schemaVersion: "a2a.runner.operator-task-report.v1",
    taskId: event.taskId,
    status: result.status,
    evidenceKind: event.evidenceKind,
    worker: event.worker,
    repo: event.repo,
    issue: event.issue,
    issueTitle: event.issueTitle,
    taskBrief: event.taskBrief,
    url: result.prUrl ?? result.doneCommentUrl ?? result.blockCommentUrl ?? event.prUrl ?? event.doneUrl ?? event.blockUrl,
    summary: result.summary,
    tests: result.tests,
    risks: result.risks,
    runnerBuild: event.runnerBuild,
    dedupeKey: event.dedupeKey,
  }) as unknown as OperatorTaskReportEvidence;
}

export function buildTerminalAckDecision(
  event: TerminalEvidenceEvent,
  receipt?: TerminalAckReceipt,
): TerminalAckDecision {
  const hasTerminalEvidence = event.evidenceKind === "PR" || event.evidenceKind === "Done" || event.evidenceKind === "Block";
  const hasOperatorVisibleReceipt = receipt?.operatorVisible === true
    && Boolean(receipt.receiptId || receipt.url || receipt.deliveredAt);
  const acknowledged = hasTerminalEvidence && hasOperatorVisibleReceipt;
  const safeReceipt = hasOperatorVisibleReceipt ? {
    channel: receipt?.channel,
    receiptId: receipt?.receiptId,
    url: receipt?.url,
    deliveredAt: receipt?.deliveredAt,
  } : undefined;

  const decision: TerminalAckDecision = {
    schemaVersion: "a2a.runner.terminal-ack.v1",
    eventId: event.eventId,
    taskId: event.taskId,
    evidenceKind: event.evidenceKind,
    acknowledged,
    cursorComplete: acknowledged,
    reason: acknowledged
      ? "terminal evidence has operator-visible receipt"
      : hasTerminalEvidence
        ? "operator-visible receipt required before terminal ack"
        : "PR/Done/Block terminal evidence required before terminal ack",
  };
  if (safeReceipt) decision.receipt = omitUndefined(safeReceipt) as TerminalAckDecision["receipt"];
  return decision;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function resultFilesChanged(result: RawRunnerOutput): string[] {
  const manifestArtifacts = result.artifactManifest?.artifacts;
  if (manifestArtifacts && manifestArtifacts.length > 0) {
    return manifestArtifacts.map((artifact) => artifact.path);
  }
  return result.artifacts ?? [];
}

function brokerFacingRunnerRaw(result: RawRunnerOutput): Record<string, unknown> {
  const stdout = result.resultSummary?.stdout ?? brokerBoundText(result.stdout);
  const stderr = result.resultSummary?.stderr ?? brokerBoundText(result.stderr);
  const error = result.error ? brokerBoundText(result.error) : undefined;

  return omitUndefined({
    ok: result.ok,
    taskId: result.taskId,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
    stdoutTruncated: result.resultSummary?.stdoutTruncated ?? stdout !== result.stdout,
    stderrTruncated: result.resultSummary?.stderrTruncated ?? stderr !== result.stderr,
    artifactCount: result.resultSummary?.artifactCount ?? resultFilesChanged(result).length,
    artifacts: resultFilesChanged(result),
    manifestPath: result.resultSummary?.manifestPath ?? result.artifactManifest?.manifestPath,
    runnerBuild: result.resultSummary?.runnerBuild ?? result.runnerBuild,
    budget: result.resultSummary?.budget ?? result.artifactManifest?.budget,
    continuation: result.resultSummary?.continuation ?? result.artifactManifest?.continuation,
    prUrl: result.prUrl,
    github: result.github,
    error,
  });
}

function validateBudgetContinuationContract(result: RawRunnerOutput): void {
  const manifestStatus = result.artifactManifest?.status;
  const summaryStatus = result.resultSummary?.status;
  const budgetLimited = manifestStatus === "budget_limited" || summaryStatus === "budget_limited";
  const budget = result.resultSummary?.budget ?? result.artifactManifest?.budget;
  const continuation = result.resultSummary?.continuation ?? result.artifactManifest?.continuation;

  if (!budgetLimited && !budget && !continuation) return;
  if (budgetLimited && !budget) throw new Error("budget_limited runner output missing budget evidence");
  if (budget && !["time", "token", "attempt", "command", "safety"].includes(budget.limitKind)) {
    throw new Error("runner budget evidence has invalid limitKind");
  }
  if (continuation) {
    if (typeof continuation.recommended !== "boolean") throw new Error("runner continuation evidence missing recommended boolean");
    if (continuation.requiresApproval !== true) throw new Error("runner continuation evidence must require approval");
    if (continuation.nextPrompt && /(?:token|password|secret|api[_-]?key)\s*=/i.test(continuation.nextPrompt)) {
      throw new Error("runner continuation nextPrompt appears to contain a secret assignment");
    }
  }
}

function isBudgetLimitedResult(result: RawRunnerOutput): boolean {
  return result.artifactManifest?.status === "budget_limited" || result.resultSummary?.status === "budget_limited";
}

function safeContinuationRecommendation(result: RawRunnerOutput): string {
  const continuation = result.resultSummary?.continuation ?? result.artifactManifest?.continuation;
  const budget = result.resultSummary?.budget ?? result.artifactManifest?.budget;
  const reason = budget?.reason ? ` (${boundReason(budget.reason)})` : "";
  if (continuation?.recommended === true) {
    const prompt = continuation.nextPrompt ? ` Suggested prompt: ${boundReason(continuation.nextPrompt)}` : "";
    return `Review artifacts, then approve one bounded continuation task before resuming${reason}.${prompt}`.trim();
  }
  return `Review artifacts and budget evidence before deciding whether to start a new bounded task${reason}.`;
}

const BROKER_RUNNER_STREAM_LIMIT = 2_000;

function brokerBoundText(value: string): string {
  if (value.length <= BROKER_RUNNER_STREAM_LIMIT) return value;
  const omitted = value.length - BROKER_RUNNER_STREAM_LIMIT;
  return `${value.slice(0, BROKER_RUNNER_STREAM_LIMIT)}
<truncated ${omitted} chars for broker update>`;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function stableEventId(taskId: string, status: TerminalEvidenceStatus, kind: TerminalEvidenceKind, url: string): string {
  return ["a2a-terminal", taskId, status, kind, url]
    .map((part) => part.replace(/[^A-Za-z0-9_.:/#-]+/g, "_").slice(0, 160))
    .join(":");
}

function normalizeIssueReference(task: HandlerTask): string | undefined {
  const issueUrl = normalizeString(task?.payload?.issueUrl);
  if (issueUrl) return issueUrl;
  const issue = extractIssueNumber(task);
  const repo = normalizeString(task?.payload?.repo);
  if (repo && issue && /^\d+$/.test(issue)) return `https://github.com/${repo}/issues/${issue}`;
  return issue;
}

function normalizeGitHubIssueUrl(value?: string, repo?: string, issue?: string | number): string | undefined {
  const safeValue = normalizeString(value);
  if (safeValue && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+(?:[#?].*)?$/.test(safeValue)) {
    return safeValue;
  }
  const issueNumber = issue == null ? undefined : String(issue).match(/#?(\d+)/)?.[1];
  if (repo && issueNumber && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return `https://github.com/${repo}/issues/${issueNumber}`;
  }
  return undefined;
}

function buildTestSummaryLabel(result: RawRunnerOutput, kind: TerminalEvidenceKind): string {
  const exit = result.resultSummary?.exitCode ?? result.exitCode;
  const timedOut = result.resultSummary?.timedOut ?? result.status === "timeout";
  const artifacts = result.resultSummary?.artifactCount ?? result.artifacts?.length ?? 0;
  const outcome = isBudgetLimitedResult(result)
    ? "budget-limited continuation evidence"
    : kind === "PR" ? "PR evidence" : kind === "Done" ? "Done evidence" : kind === "Block" ? "Block evidence" : "missing terminal evidence";
  return `a2a-docker-runner ${result.status}; ${outcome}; exit=${exit ?? "null"}; timedOut=${timedOut}; artifacts=${artifacts}`;
}

function buildTerminalAlert(input: {
  taskId: string;
  status: TerminalEvidenceStatus;
  evidenceKind: TerminalEvidenceKind;
  worker: string;
  repo?: string;
  issue?: string;
  issueTitle?: string;
  taskBrief?: string;
  url?: string;
  result: RawRunnerOutput;
  testSummary: { exitCode?: number | null; timedOut?: boolean; artifactCount?: number };
}): { title: string; body: string; url?: string } {
  const icon = input.evidenceKind === "PR"
    ? "PR"
    : input.evidenceKind === "Done"
      ? "Done"
      : input.evidenceKind === "Block"
        ? "Block"
        : input.evidenceKind === "BudgetLimited"
          ? "Budget limited"
          : input.evidenceKind === "TimedOut"
            ? "Timeout"
            : "Needs review";
  const target = input.repo ?? input.issue ?? input.taskId;
  const title = boundAlertPart(`A2A ${icon}: ${target}`, 96);
  const bodyParts = [
    `task=${input.taskId}`,
    `worker=${input.worker}`,
    `status=${input.status}`,
    `exit=${input.testSummary.exitCode ?? "null"}`,
    `timeout=${input.testSummary.timedOut === true}`,
    `artifacts=${input.testSummary.artifactCount ?? 0}`,
  ];
  const issueRef = compactIssueRef(input.issue);
  if (issueRef) bodyParts.push(`issue=${issueRef}`);
  if (input.issueTitle) bodyParts.push(`title=${input.issueTitle}`);
  if (input.taskBrief) bodyParts.push(`brief=${input.taskBrief}`);
  const reason = buildTerminalReason(input.result, input.evidenceKind);
  bodyParts.push(`reason=${reason}`);
  return omitUndefined({
    title,
    body: boundAlertPart(bodyParts.join(" · "), 360),
    url: input.url,
  }) as { title: string; body: string; url?: string };
}

function compactIssueRef(issue?: string): string | undefined {
  if (!issue) return undefined;
  const match = issue.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (match) return `${match[1]}#${match[2]}`;
  return issue.startsWith("http://") || issue.startsWith("https://") ? undefined : issue;
}

function boundAlertPart(value: string, max: number): string {
  const compact = boundReason(value);
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 3))}...`;
}

function buildTerminalReason(result: RawRunnerOutput, kind: TerminalEvidenceKind): string {
  if (kind === "PR") return "PR evidence is available for operator review.";
  if (kind === "Done") return "Done evidence was posted because no PR was needed.";
  if (kind === "Block") return shortSafeReason(result, "Block evidence was posted for operator follow-up.");
  if (kind === "BudgetLimited" || isBudgetLimitedResult(result)) return safeContinuationRecommendation(result);
  if (kind === "TimedOut" || result.status === "timeout") return "Runner timed out before producing PR/Done/Block evidence.";
  if (!result.ok) return shortSafeReason(result, "Runner failed before producing PR/Done/Block evidence.");
  return "Runner completed without PR/Done/Block evidence.";
}

function shortSafeReason(result: RawRunnerOutput, fallback: string): string {
  const source = result.error ?? result.resultSummary?.stderr ?? result.resultSummary?.stdout;
  const firstLine = source?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return fallback;
  return boundReason(firstLine);
}

function boundReason(value: string): string {
  const compact = value
    .replace(/x-access-token:[^@\s]+@github\.com/g, "x-access-token:<redacted>@github.com")
    .replace(/(token|password|secret|api[_-]?key)=\S+/gi, "$1=<redacted>")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD)=\S+/g, "<redacted-secret-env>")
    .replace(/\/[^\s:;,)]+(?:\/[^\s:;,)]+)+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177)}...`;
}

function safeEvidenceText(value: string | undefined, maxLen: number): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  const safe = boundReason(normalized);
  return safe.length <= maxLen ? safe : `${safe.slice(0, Math.max(0, maxLen - 3))}...`;
}

function normalizeString(value?: string): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeExistingPrUrl(task: HandlerTask, repo?: string): string | undefined {
  const explicit = normalizeString(task?.payload?.existingPrUrl ?? task?.payload?.prUrl);
  if (explicit) return explicit;

  const prNumber = task?.payload?.existingPrNumber ?? task?.payload?.prNumber;
  const pr = prNumber != null ? String(prNumber).match(/#?(\d+)/)?.[1] : undefined;
  if (!repo || !pr) return undefined;
  return `https://github.com/${repo}/pull/${pr}`;
}

function extractIssueNumber(task: HandlerTask): string | undefined {
  const raw = normalizeString(task?.payload?.issue ?? task?.payload?.issueNumber);
  if (!raw) return undefined;
  const match = raw.match(/#?(\d+)/);
  return match ? match[1] : raw;
}

// ── Re-exports that the handler may need ───────────────────────────────────
export type { RunnerTask } from "./types.js";
export type { GitHubEvidence } from "./types.js";
