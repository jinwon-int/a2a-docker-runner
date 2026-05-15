import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { RESULT_STREAM_LIMIT, redactSecrets, redactAndBound, sanitizeSourcePublicApprovalRehearsal } from "./runner.js";
import { sanitizeSourcePublicExecutionPreflight } from "./source-public-preflight.js";
import type { ArtifactManifest } from "./types.js";

/**
 * Runner deterministic history scanner.
 *
 * Walks the runner's rootDir tree (rootDir/<safeTaskId>/<runToken>/)
 * and produces a deterministic, redacted scan profile suitable for
 * evidence, audit, and operator review.
 *
 * Parent: a2a-docker-runner#177
 * Parent: a2a-plane#197
 */

export interface ScanOptions {
  /** Runner rootDir (as configured in RunnerConfig.rootDir). */
  rootDir: string;
  /** Max run entries in the profile. Defaults to 100. */
  limit?: number;
  /** Minimum age (ms) for run directories to be included. */
  minAgeMs?: number;
  /** Reference now-ms for age calculations (deterministic override). */
  nowMs?: number;
}

export interface ScanRunEntry {
  taskId: string;
  safeTaskId: string;
  runToken: string;
  createdAt: string;
  status: string;
  outcome?: string;
  artifactCount: number;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  issueUrl?: string;
  githubCommentProjection?: {
    kind: "pr" | "done" | "block";
    url: string;
    dedupeKey: string;
    commentIsTerminalAck: false;
    commentIsVisibilityReceipt: false;
    commentIsOperatorApproval: false;
  };
  sourcePublicApprovalRehearsal?: {
    decision: "GO_CANDIDATE" | "NO_GO" | "NEEDS_OPERATOR_APPROVAL";
    approvalPacketCount: number;
    terminalBriefRehearsalOnly: true;
    dedupeKey: string;
    operatorApprovalRequired: true;
    sourcePublicExecutionBlocked: true;
    approvalExecuted: false;
    releaseExecuted: false;
    visibilityChanged: false;
    liveProviderSendPerformed: false;
    terminalAckSent: false;
    dbMutationPerformed: false;
  };
  sourcePublicExecutionPreflight?: {
    mode: "dry_run" | "simulate";
    status: "ready_for_operator_approval" | "blocked";
    planId: string;
    planDedupeKey: string;
    manifestDigest: string;
    historyDigest: string;
    historyRunCount: number;
    failureReasons: string[];
    operatorApprovalRequired: true;
    sourcePublicExecutionBlocked: true;
    approvalExecuted: false;
    releaseExecuted: false;
    visibilityChanged: false;
    liveProviderSendPerformed: false;
    terminalAckSent: false;
    dbMutationPerformed: false;
    deployOrRestartPerformed: false;
  };
  summary?: string;
  exitCode?: number | null;
  branch?: string;
  timedOut?: boolean;
  budgetLimitKind?: string;
}

export interface ScanProfile {
  schemaVersion: "a2a.runner.scan-profile.v1";
  /** Deterministic timestamp. */
  generatedAt: "1970-01-01T00:00:00.000Z";
  /** The scan root label (never an absolute host path). */
  rootLabel: string;
  /** Total runs discovered (before limit/age filter). */
  totalRunDirs: number;
  /** Runs included in this profile. Sorted deterministic by runToken. */
  runs: ScanRunEntry[];
}

const DEFAULT_SCAN_LIMIT = 100;

/**
 * Scan runner history and produce a deterministic, redacted scan profile.
 *
 * The output:
 * - Never contains absolute host paths (uses rootLabel).
 * - Has a deterministic `generatedAt` timestamp.
 * - Sorts runs by runToken for deterministic ordering.
 * - Redacts all secrets from summaries and metadata.
 * - Truncates long fields at safe bounds.
 */
export async function scanHistory(options: ScanOptions): Promise<ScanProfile> {
  const rootDir = resolve(options.rootDir);
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_SCAN_LIMIT;
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 0;

  const entries: ScanRunEntry[] = [];
  let totalRunDirs = 0;

  let taskRoots: string[];
  try {
    taskRoots = await readdir(rootDir);
  } catch {
    return {
      schemaVersion: "a2a.runner.scan-profile.v1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      rootLabel: sanitizeRootLabel(rootDir),
      totalRunDirs: 0,
      runs: [],
    };
  }

  // Sort task roots for deterministic output.
  taskRoots.sort();

  for (const entry of taskRoots) {
    const taskRoot = join(rootDir, entry);
    const taskRootInfo = await stat(taskRoot).catch(() => undefined);
    if (!taskRootInfo?.isDirectory()) continue;

    let runDirs: string[];
    try {
      runDirs = await readdir(taskRoot);
    } catch {
      continue;
    }

    // Sort run dirs deterministically.
    runDirs.sort();

    for (const runEntry of runDirs) {
      const runDir = join(taskRoot, runEntry);
      const runInfo = await stat(runDir).catch(() => undefined);
      if (!runInfo?.isDirectory()) continue;

      totalRunDirs++;

      // Age filter.
      const ageMs = await runAgeMs(runDir, nowMs, runInfo.mtimeMs);
      if (ageMs < minAgeMs) continue;

      if (entries.length >= limit) continue;

      const scanEntry = await buildScanRunEntry(runDir, entry, runEntry);
      if (scanEntry) entries.push(scanEntry);
    }
  }

  // Deterministic sort by runToken.
  entries.sort((a, b) => a.runToken.localeCompare(b.runToken));

  // Truncate to limit after sort.
  const runs = entries.slice(0, limit);

  return {
    schemaVersion: "a2a.runner.scan-profile.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: sanitizeRootLabel(rootDir),
    totalRunDirs,
    runs,
  };
}

async function buildScanRunEntry(
  runDir: string,
  safeTaskId: string,
  runToken: string,
): Promise<ScanRunEntry | undefined> {
  // Read run.json for metadata.
  let runMeta: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(join(runDir, "run.json"), "utf8");
    runMeta = JSON.parse(raw);
  } catch {
    // Malformed run.json; produce minimal entry.
  }

  // Read task.json (prefer the redacted artifact copy).
  let taskMeta: Record<string, unknown> | undefined;
  const taskSources = ["artifacts/task.json", "task.json"];
  for (const src of taskSources) {
    try {
      const raw = await readFile(join(runDir, src), "utf8");
      taskMeta = JSON.parse(raw);
      break;
    } catch {
      continue;
    }
  }

  // Read artifact manifest.
  let manifest: ArtifactManifest | undefined;
  try {
    const raw = await readFile(join(runDir, "artifacts", "manifest.json"), "utf8");
    manifest = JSON.parse(raw);
  } catch {
    // No manifest.
  }

  const taskId = typeof taskMeta?.id === "string" ? taskMeta.id : safeTaskId;
  const createdAt = typeof runMeta?.createdAt === "string" ? runMeta.createdAt : "unknown";
  const exitCode = readExitCode(runMeta, manifest);
  const timedOut = readTimedOut(runMeta, manifest);

  const entry: ScanRunEntry = {
    taskId: redactSecrets(sanitizeScanText(taskId, 200)),
    safeTaskId: sanitizeScanText(safeTaskId, 200),
    runToken: sanitizeScanText(runToken, 200),
    createdAt: sanitizeScanText(createdAt, 80),
    status: inferScanStatus(manifest, exitCode, timedOut),
    artifactCount: manifest?.artifacts?.length ?? 0,
  };

  // Redacted optional fields.
  const prUrl = manifest?.prUrl ?? (runMeta as Record<string, unknown>)?.prUrl;
  if (typeof prUrl === "string" && isSafeGitHubUrl(prUrl)) entry.prUrl = prUrl;

  const issueUrl = manifest?.issueUrl ?? (taskMeta as Record<string, unknown>)?.issueUrl;
  if (typeof issueUrl === "string" && isSafeGitHubUrl(issueUrl)) entry.issueUrl = issueUrl;

  const hints = sanitizeEvidenceHints(manifest?.evidenceHints);
  if (hints?.doneUrl) entry.doneUrl = hints.doneUrl;
  if (hints?.blockUrl) entry.blockUrl = hints.blockUrl;
  const projection = sanitizeGitHubCommentProjection(manifest?.githubCommentProjection);
  if (projection) {
    entry.githubCommentProjection = {
      kind: projection.kind,
      url: projection.url,
      dedupeKey: projection.dedupeKey,
      commentIsTerminalAck: false,
      commentIsVisibilityReceipt: false,
      commentIsOperatorApproval: false,
    };
  }
  const sourcePublicApprovalRehearsal = sanitizeSourcePublicApprovalRehearsal(manifest?.sourcePublicApprovalRehearsal);
  if (sourcePublicApprovalRehearsal) {
    entry.sourcePublicApprovalRehearsal = {
      decision: sourcePublicApprovalRehearsal.decision,
      approvalPacketCount: sourcePublicApprovalRehearsal.approvalPackets.length,
      terminalBriefRehearsalOnly: true,
      dedupeKey: sourcePublicApprovalRehearsal.replayNoDuplicateProof.dedupeKey,
      operatorApprovalRequired: true,
      sourcePublicExecutionBlocked: true,
      approvalExecuted: false,
      releaseExecuted: false,
      visibilityChanged: false,
      liveProviderSendPerformed: false,
      terminalAckSent: false,
      dbMutationPerformed: false,
    };
  }
  const sourcePublicExecutionPreflight = sanitizeSourcePublicExecutionPreflight(manifest?.sourcePublicExecutionPreflight);
  if (sourcePublicExecutionPreflight) {
    entry.sourcePublicExecutionPreflight = {
      mode: sourcePublicExecutionPreflight.mode,
      status: sourcePublicExecutionPreflight.status,
      planId: sourcePublicExecutionPreflight.executionPlan.planId,
      planDedupeKey: sourcePublicExecutionPreflight.executionPlan.planDedupeKey,
      manifestDigest: sourcePublicExecutionPreflight.scannerHistoryBinding.manifestDigest,
      historyDigest: sourcePublicExecutionPreflight.scannerHistoryBinding.historyDigest,
      historyRunCount: sourcePublicExecutionPreflight.scannerHistoryBinding.historyRunCount,
      failureReasons: sourcePublicExecutionPreflight.preflightFailureSemantics.reasons,
      operatorApprovalRequired: true,
      sourcePublicExecutionBlocked: true,
      approvalExecuted: false,
      releaseExecuted: false,
      visibilityChanged: false,
      liveProviderSendPerformed: false,
      terminalAckSent: false,
      dbMutationPerformed: false,
      deployOrRestartPerformed: false,
    };
  }

  if (manifest?.status) entry.outcome = sanitizeScanText(String(manifest.status), 60);
  if (typeof exitCode === "number") entry.exitCode = exitCode;
  if (timedOut) entry.timedOut = true;
  if (manifest?.branch) entry.branch = sanitizeScanText(String(manifest.branch), 200);
  if (manifest?.budget?.limitKind) entry.budgetLimitKind = sanitizeScanText(manifest.budget.limitKind, 40);

  // Redacted summary: never more than 300 chars.
  if (manifest?.summary) {
    entry.summary = redactAndBound(manifest.summary.trim(), 260);
  } else {
    // Fallback: first line of summary.txt.
    try {
      const summaryRaw = await readFile(join(runDir, "artifacts", "summary.txt"), "utf8");
      const firstLine = summaryRaw.split(/\r?\n/)[0]?.trim();
      if (firstLine) {
        entry.summary = redactAndBound(firstLine, 300);
      }
    } catch {
      // No summary.
    }
  }

  return entry;
}

function readExitCode(
  runMeta: Record<string, unknown> | undefined,
  _manifest: ArtifactManifest | undefined,
): number | null | undefined {
  if (typeof runMeta?.exitCode === "number") return runMeta.exitCode;
  return undefined;
}

function readTimedOut(
  runMeta: Record<string, unknown> | undefined,
  _manifest: ArtifactManifest | undefined,
): boolean | undefined {
  if (runMeta?.timedOut === true) return true;
  return undefined;
}

function inferScanStatus(
  manifest: ArtifactManifest | undefined,
  exitCode: number | null | undefined,
  timedOut: boolean | undefined,
): string {
  if (timedOut) return "timeout";
  if (manifest?.status) return manifest.status;
  if (exitCode === 0) return "completed";
  if (exitCode != null && exitCode !== 0) return "failed";
  return "unknown";
}

/**
 * Calculate the age of a run directory in milliseconds.
 *
 * Prefers the `createdAt` field from run.json (ISO timestamp) when available.
 * Falls back to directory mtimeMs when run.json is missing or unreadable.
 */
async function runAgeMs(runDir: string, nowMs: number, mtimeMsFallback: number): Promise<number> {
  try {
    const content = await readFile(join(runDir, "run.json"), "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.createdAt === "string") {
      const createdAtMs = new Date(parsed.createdAt).getTime();
      if (!isNaN(createdAtMs)) {
        return Math.max(0, nowMs - createdAtMs);
      }
    }
  } catch {
    // fall through to mtime fallback.
  }
  return Math.max(0, nowMs - mtimeMsFallback);
}

function sanitizeScanText(value: string, maxLen: number): string {
  const cleaned = value.replace(/\0/g, "").replace(/[\r\n]+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 12).trimEnd() + "...truncated";
}

function isSafeGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

function isGitHubProjectionKind(value: unknown): value is "pr" | "done" | "block" {
  return value === "pr" || value === "done" || value === "block";
}

function sanitizeEvidenceHints(hints: ArtifactManifest["evidenceHints"] | undefined): ArtifactManifest["evidenceHints"] | undefined {
  if (!hints || hints.schemaVersion !== "a2a.runner.evidence-hints.v1") return undefined;
  const safe: ArtifactManifest["evidenceHints"] = { schemaVersion: "a2a.runner.evidence-hints.v1" };
  if (typeof hints.issueUrl === "string" && isSafeGitHubUrl(hints.issueUrl)) safe.issueUrl = hints.issueUrl;
  if (typeof hints.startCommentUrl === "string" && isSafeGitHubUrl(hints.startCommentUrl)) safe.startCommentUrl = hints.startCommentUrl;
  if (typeof hints.prUrl === "string" && isSafeGitHubUrl(hints.prUrl)) safe.prUrl = hints.prUrl;
  if (typeof hints.doneUrl === "string" && isSafeGitHubUrl(hints.doneUrl)) safe.doneUrl = hints.doneUrl;
  if (typeof hints.blockUrl === "string" && isSafeGitHubUrl(hints.blockUrl)) safe.blockUrl = hints.blockUrl;
  if (typeof hints.branch === "string") safe.branch = sanitizeScanText(redactSecrets(hints.branch), 160);
  if (typeof hints.branchUrl === "string" && isSafeGitHubUrl(hints.branchUrl)) safe.branchUrl = hints.branchUrl;
  if (hints.failureCategory) safe.failureCategory = hints.failureCategory;
  return Object.keys(safe).length > 1 ? safe : undefined;
}

function sanitizeGitHubCommentProjection(
  projection: ArtifactManifest["githubCommentProjection"] | undefined,
): ArtifactManifest["githubCommentProjection"] | undefined {
  if (!projection || projection.schemaVersion !== "a2a.runner.github-comment-projection.v1") return undefined;
  if (!isGitHubProjectionKind(projection.kind) || !isSafeGitHubUrl(projection.url)) return undefined;
  if (projection.issueUrl && !isSafeGitHubUrl(projection.issueUrl)) return undefined;
  if (projection.commentIsTerminalAck !== false || projection.commentIsVisibilityReceipt !== false || projection.commentIsOperatorApproval !== false) return undefined;
  const dedupeKey = sanitizeScanText(redactSecrets(projection.dedupeKey), 300);
  if (!dedupeKey) return undefined;
  const manifestPath = "artifacts/manifest.json";
  return {
    schemaVersion: "a2a.runner.github-comment-projection.v1",
    kind: projection.kind,
    url: projection.url,
    ...(projection.issueUrl ? { issueUrl: projection.issueUrl } : {}),
    manifestPath,
    dedupeKey,
    commentIsTerminalAck: false,
    commentIsVisibilityReceipt: false,
    commentIsOperatorApproval: false,
  };
}

/**
 * Produce a safe, path-info-free label for the scan root directory.
 * The label is deterministic and never contains host-specific absolute paths.
 */
function sanitizeRootLabel(rootDir: string): string {
  const resolved = resolve(rootDir);
  const last = basename(resolved) || resolved;
  // Use only the last path component for safety.
  return `runner-root:${sanitizeScanText(last, 80)}`;
}

/**
 * Create a redacted artifact bundle from a runner workDir.
 *
 * Copies artifacts/text files into a self-contained output directory,
 * applying secret redaction to all text content.  Produces a bundle
 * manifest matching the artifact manifest contract.
 *
 * Parent: a2a-docker-runner#177
 */
export interface BundleOptions {
  /** Source workDir (a run-token directory). */
  workDir: string;
  /** Output directory for the bundle. Will be created if missing. */
  outputPath: string;
}

export async function createArtifactBundle(options: BundleOptions): Promise<ArtifactManifest> {
  const workDir = resolve(options.workDir);
  const outputPath = resolve(options.outputPath);

  await mkdir(outputPath, { recursive: true, mode: 0o700 });

  // Read the source manifest, if available.
  let sourceManifest: ArtifactManifest | undefined;
  try {
    const raw = await readFile(join(workDir, "artifacts", "manifest.json"), "utf8");
    sourceManifest = JSON.parse(raw);
  } catch {
    // No source manifest; proceed with what we find on disk.
  }

  // Copy and redact all artifact files.
  const entries: { path: string; name: string; sizeBytes: number }[] = [];
  const artifactsDir = join(workDir, "artifacts");

  try {
    const artifactNames = await readdir(artifactsDir);
    const sorted = artifactNames.sort();

    for (const name of sorted) {
      const srcPath = join(artifactsDir, name);
      const info = await stat(srcPath).catch(() => undefined);
      if (!info?.isFile()) continue;

      const destPath = join(outputPath, name);
      await copyAndRedactFile(srcPath, destPath);
      const destInfo = await stat(destPath);
      entries.push({
        path: name,
        name,
        sizeBytes: destInfo.size,
      });
    }
  } catch {
    // No artifacts directory; empty bundle.
  }

  const evidenceHints = sanitizeEvidenceHints(sourceManifest?.evidenceHints);
  const githubCommentProjection = sanitizeGitHubCommentProjection(sourceManifest?.githubCommentProjection);
  const sourcePublicApprovalRehearsal = sanitizeSourcePublicApprovalRehearsal(sourceManifest?.sourcePublicApprovalRehearsal);
  const sourcePublicExecutionPreflight = sanitizeSourcePublicExecutionPreflight(sourceManifest?.sourcePublicExecutionPreflight);

  // Build the bundle manifest.
  const bundleManifest: ArtifactManifest = {
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(sourceManifest?.taskId ? { taskId: sourceManifest.taskId } : {}),
    ...(sourceManifest?.repo ? { repo: sourceManifest.repo } : {}),
    ...(sourceManifest?.branch ? { branch: sourceManifest.branch } : {}),
    ...(sourceManifest?.prUrl && typeof sourceManifest.prUrl === "string" && isSafeGitHubUrl(sourceManifest.prUrl) ? { prUrl: sourceManifest.prUrl } : {}),
    ...(sourceManifest?.issueUrl && typeof sourceManifest.issueUrl === "string" && isSafeGitHubUrl(sourceManifest.issueUrl) ? { issueUrl: sourceManifest.issueUrl } : {}),
    status: sourceManifest?.status ?? "done",
    summary: redactAndBound((sourceManifest?.summary ?? "Redacted artifact bundle produced by a2a-docker-runner scanner.").trim(), 300),
    evidence: sourceManifest?.evidence ?? [],
    artifacts: entries,
    ...(evidenceHints ? { evidenceHints } : {}),
    ...(githubCommentProjection ? { githubCommentProjection } : {}),
    ...(sourcePublicApprovalRehearsal ? { sourcePublicApprovalRehearsal } : {}),
    ...(sourcePublicExecutionPreflight ? { sourcePublicExecutionPreflight } : {}),
  };

  // Write the bundle manifest.
  await writeFile(join(outputPath, "manifest.json"), JSON.stringify(bundleManifest, null, 2) + "\n");

  return bundleManifest;
}

/**
 * Copy a file to destPath, applying secret redaction to text content.
 * Binary files are copied as-is.
 */
async function copyAndRedactFile(srcPath: string, destPath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(srcPath, "utf8");
  } catch {
    // Not a text file or unreadable; copy raw.
    const { copyFile } = await import("node:fs/promises");
    await copyFile(srcPath, destPath);
    return;
  }

  // Redact known secret patterns and write.
  const redacted = redactSecrets(content);
  // Truncate at stream limit to bound output size.
  const bounded = redacted.length > RESULT_STREAM_LIMIT
    ? redacted.slice(0, RESULT_STREAM_LIMIT) + `\n<truncated ${redacted.length - RESULT_STREAM_LIMIT} chars>`
    : redacted;

  await writeFile(destPath, bounded);
}

/**
 * Runner readiness harness for stale/malformed task and artifact ownership detection.
 *
 * Runs a scan over the runner rootDir and produces a deterministic readiness report
 * that flags stale runs, malformed runs, and orphan task-root directories — without
 * any DB mutation, prune, or state change.  Safe for audit and evidence lanes.
 *
 * Parent: a2a-docker-runner#219
 * Parent: a2a-broker#511
 * Parent: a2a-broker#497 / a2a-broker#294
 */

/** Status of a single run as classified by the readiness scanner. */
export type ReadinessRunStatus =
  | "ok"
  | "stale"
  | "malformed"
  | "orphan";

export interface ReadinessRunEntry {
  safeTaskId: string;
  runToken: string;
  /** Age in ms since creation (or mtime when createdAt is unparseable). */
  ageMs: number;
  status: ReadinessRunStatus;
  /** Terminal status flag: the run has a known end state (done/failed/blocked/timeout). */
  terminal: boolean;
  /** True when run.json could not be parsed. */
  runJsonMalformed: boolean;
  /** True when manifest.json could not be parsed. */
  manifestMalformed: boolean;
  /** True when a task-root directory has no valid run subdirectories. */
  orphanTaskRoot: boolean;
  /** Redacted reason string (max 160 chars). */
  reason?: string;
}

export interface ReadinessReport {
  schemaVersion: "a2a.runner.readiness-report.v1";
  /** Deterministic timestamp. */
  generatedAt: "1970-01-01T00:00:00.000Z";
  /** Redacted root label. */
  rootLabel: string;
  /** Total task-root directories discovered. */
  totalTaskRoots: number;
  /** Total run directories discovered. */
  totalRunDirs: number;
  /** Runs that exceed the stale threshold with no terminal status. */
  staleRuns: number;
  /** Runs with unparseable run.json or manifest.json. */
  malformedRuns: number;
  /** Task-root directories with no valid run subdirectories (orphans). */
  orphanTaskRoots: number;
  /** Per-run readiness entries (sorted deterministically by runToken). */
  runs: ReadinessRunEntry[];
}

export interface ReadinessOptions {
  /** Runner rootDir (as configured in RunnerConfig.rootDir). */
  rootDir: string;
  /** Age threshold in ms above which an unfinished run is considered stale. */
  staleThresholdMs: number;
  /** Reference now-ms for age calculations (deterministic override). */
  nowMs?: number;
  /** Max run entries in the report. Defaults to 200. */
  limit?: number;
}

const DEFAULT_READINESS_LIMIT = 200;

/** Terminal status values that mark a run as finished. */
const TERMINAL_STATUSES = new Set([
  "done", "completed", "failed", "blocked", "timeout",
  "stale", "no_changes_allowed", "comment_only_done",
]);

// ---------------------------------------------------------------------------
// Cleanup dry-run plan (a2a-docker-runner#223 / a2a-broker#519)
// ---------------------------------------------------------------------------

/** Risk classification for a single cleanup candidate. */
export type CleanupRiskClass = "low" | "medium" | "high" | "blocked";

/** A single cleanup candidate entry in the dry-run plan. */
export interface CleanupDryRunEntry {
  /** Stable identifier derived from safeTaskId + runToken. */
  candidateId: string;
  safeTaskId: string;
  runToken: string;
  /** Age in ms at scan time. */
  ageMs: number;
  /** The readiness classification that triggered this candidate. */
  trigger: ReadinessRunStatus;
  /** Risk class for this specific entry. */
  riskClass: CleanupRiskClass;
  /** Redacted reason (max 200 chars). */
  reason: string;
  /** Terminal-status flag from the readiness report. */
  terminal: boolean;
}

/**
 * A deterministic, operator-gated dry-run cleanup plan.
 *
 * Produced from a readiness report.  Never mutates disk state.  Every plan
 * includes explicit safety markers, backup requirements, an approval gate,
 * and rollback notes.  Real cleanup execution requires a separate operator
 * approval step after backup verification.
 */
export interface CleanupDryRunPlan {
  schemaVersion: "a2a.runner.cleanup-dry-run-plan.v1";
  /** Deterministic timestamp. */
  generatedAt: "1970-01-01T00:00:00.000Z";
  /** Stable plan id, derived from rootLabel + candidate digest. */
  planId: string;
  /** The readiness report summary this plan is bound to. */
  boundReadinessReport: {
    rootLabel: string;
    totalTaskRoots: number;
    totalRunDirs: number;
    staleRuns: number;
    malformedRuns: number;
    orphanTaskRoots: number;
  };
  /** Aggregate counts. */
  summary: {
    totalCandidates: number;
    byRiskClass: Record<CleanupRiskClass, number>;
    byTrigger: Record<ReadinessRunStatus, number>;
  };
  /** Individual cleanup entries, sorted deterministically by candidateId. */
  entries: CleanupDryRunEntry[];
  /** Safety markers — all must be explicitly false/blocked for dry-run plans. */
  safety: {
    mutationPerformed: false;
    operatorApprovalRequired: true;
    backupRequired: true;
    staleWorkerRowsMayBeValid: true;
    liveProviderSendPerformed: false;
    terminalAckSent: false;
    dbMutationPerformed: false;
  };
  /** Operator pre-execution checklist. */
  preExecutionChecklist: string[];
  /** Rollback and abort notes. */
  rollbackNotes: string;
}

/** Options for buildCleanupDryRunPlan. */
export interface CleanupDryRunOptions {
  /** Max entries in the plan. Defaults to 200. */
  limit?: number;
  /** Optional prefix for candidate IDs (defaults to "cleanup"). */
  candidateIdPrefix?: string;
}

const DEFAULT_CLEANUP_LIMIT = 200;

/** Risk-class assignment by readiness status. */
function classifyRisk(status: ReadinessRunStatus, terminal: boolean, ageMs: number): CleanupRiskClass {
  switch (status) {
    case "orphan":
      // Orphan task roots have no valid runs — lowest risk to clean up.
      return "low";
    case "stale":
      // Stale but non-terminal runs may still be valid home-broker records.
      // Escalate to high when older than 7 days to encourage manual review.
      return ageMs > 7 * 24 * 3600_000 ? "high" : "medium";
    case "malformed":
      // Malformed runs are already corrupted — safe to clean but may need
      // manual inspection if they contain partial evidence.
      return terminal ? "low" : "medium";
    default:
      return "blocked";
  }
}

/**
 * Build a deterministic cleanup dry-run plan from a readiness report.
 *
 * This is a pure data-transformation function.  It never touches the
 * filesystem, never mutates state, and never performs real cleanup.
 *
 * The produced plan:
 * - Binds to the exact readiness report by rootLabel + stale/malformed/orphan counts.
 * - Assigns risk classes per entry (low / medium / high / blocked).
 * - Generates stable, deduplicable candidate IDs.
 * - Includes operator pre-execution checklist and rollback notes.
 * - Requires explicit operator approval before any mutation path.
 *
 * Safety constraints (parent: a2a-broker#519):
 * - No production DB mutation / prune / migration.
 * - No deploy / restart.
 * - No live provider send.
 * - No terminal ACK.
 * - Fail closed for stale entries that may still be valid.
 */
export function buildCleanupDryRunPlan(
  report: ReadinessReport,
  options?: CleanupDryRunOptions,
): CleanupDryRunPlan {
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_CLEANUP_LIMIT;
  const candidateIdPrefix = options?.candidateIdPrefix ?? "cleanup";

  // Only include non-ok entries as cleanup candidates.
  const candidates = report.runs.filter((r) => r.status !== "ok");

  // Build entries with risk classification.
  const entries: CleanupDryRunEntry[] = candidates.map((r, i) => ({
    candidateId: `${candidateIdPrefix}:${sanitizeScanText(r.safeTaskId, 60)}:${sanitizeScanText(r.runToken, 60)}:${String(i).padStart(4, "0")}`,
    safeTaskId: r.safeTaskId,
    runToken: sanitizeScanText(r.runToken, 200),
    ageMs: r.ageMs,
    trigger: r.status,
    riskClass: classifyRisk(r.status, r.terminal, r.ageMs),
    reason: r.reason ?? `Cleanup candidate: ${r.status}`,
    terminal: r.terminal,
  }));

  // Deterministic sort by candidateId.
  entries.sort((a, b) => a.candidateId.localeCompare(b.candidateId));

  // Truncate to limit.
  const limited = entries.slice(0, limit);

  // Aggregate counts.
  const byRiskClass: Record<CleanupRiskClass, number> = {
    low: 0,
    medium: 0,
    high: 0,
    blocked: 0,
  };
  const byTrigger: Record<ReadinessRunStatus, number> = {
    ok: 0,
    stale: 0,
    malformed: 0,
    orphan: 0,
  };
  for (const e of limited) {
    byRiskClass[e.riskClass]++;
    byTrigger[e.trigger]++;
  }

  // Stable plan ID: deterministic hash of root label + candidate counts.
  const planId = [
    candidateIdPrefix,
    report.rootLabel,
    `s${report.staleRuns}`,
    `m${report.malformedRuns}`,
    `o${report.orphanTaskRoots}`,
  ].join("-");

  const totalCandidates = limited.length;

  return {
    schemaVersion: "a2a.runner.cleanup-dry-run-plan.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    planId: sanitizeScanText(planId, 300),
    boundReadinessReport: {
      rootLabel: report.rootLabel,
      totalTaskRoots: report.totalTaskRoots,
      totalRunDirs: report.totalRunDirs,
      staleRuns: report.staleRuns,
      malformedRuns: report.malformedRuns,
      orphanTaskRoots: report.orphanTaskRoots,
    },
    summary: {
      totalCandidates,
      byRiskClass,
      byTrigger,
    },
    entries: limited,
    safety: {
      mutationPerformed: false,
      operatorApprovalRequired: true,
      backupRequired: true,
      staleWorkerRowsMayBeValid: true,
      liveProviderSendPerformed: false,
      terminalAckSent: false,
      dbMutationPerformed: false,
    },
    preExecutionChecklist: [
      "1. Verify backup of runner rootDir has been taken and validated.",
      "2. Review all HIGH-risk entries manually before proceeding.",
      "3. Confirm no active runs are in-progress for any candidate safeTaskId.",
      "4. Obtain explicit operator approval token before executing any mutation.",
      "5. Execute only against staging/test rootDir, not production.",
      "6. Keep audit log of every removed directory with before/after evidence.",
    ],
    rollbackNotes:
      "Rollback requires restoring from backup taken before cleanup execution. " +
      "Individual run directories can be restored from backup by safeTaskId/runToken path. " +
      "If the backup was not verified before execution, rollback is not guaranteed. " +
      "Abort by stopping the cleanup process before the approval token is consumed.",
  };
}

/**
 * Produce a readiness report over the runner history.
 *
 * This is a read-only audit function. It never mutates disk state,
 * prunes directories, or writes back to the runner store.
 *
 * The report flags:
 * - **stale runs**: runs older than `staleThresholdMs` without a terminal status.
 * - **malformed runs**: runs with corrupt run.json or missing manifest.json.
 * - **orphan task roots**: task directories with no valid run subdirectories.
 */
export async function readinessScan(options: ReadinessOptions): Promise<ReadinessReport> {
  const rootDir = resolve(options.rootDir);
  const nowMs = options.nowMs ?? Date.now();
  const staleThresholdMs = Math.max(0, options.staleThresholdMs);
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_READINESS_LIMIT;

  const runs: ReadinessRunEntry[] = [];
  let totalTaskRoots = 0;
  let totalRunDirs = 0;
  let staleRuns = 0;
  let malformedRuns = 0;
  let orphanTaskRoots = 0;

  let taskRoots: string[];
  try {
    taskRoots = await readdir(rootDir);
  } catch {
    return emptyReadinessReport(rootDir);
  }

  taskRoots.sort();

  for (const entry of taskRoots) {
    const taskRoot = join(rootDir, entry);
    const taskRootInfo = await stat(taskRoot).catch(() => undefined);
    if (!taskRootInfo?.isDirectory()) continue;

    totalTaskRoots++;

    let runDirs: string[];
    try {
      runDirs = await readdir(taskRoot);
    } catch {
      // Unreadable task root — treat as orphan.
      orphanTaskRoots++;
      if (runs.length < limit) {
        runs.push({
          safeTaskId: sanitizeScanText(entry, 200),
          runToken: "<unreadable>",
          ageMs: 0,
          status: "orphan",
          terminal: false,
          runJsonMalformed: false,
          manifestMalformed: false,
          orphanTaskRoot: true,
          reason: "Task root directory is unreadable.",
        });
      }
      continue;
    }

    // Detect orphan task root: no run subdirectories.
    const realRunDirs = runDirs.filter((name) => name !== "artifacts" && name !== "manifest.json");
    if (realRunDirs.length === 0) {
      orphanTaskRoots++;
      if (runs.length < limit) {
        runs.push({
          safeTaskId: sanitizeScanText(entry, 200),
          runToken: "<no-runs>",
          ageMs: 0,
          status: "orphan",
          terminal: false,
          runJsonMalformed: false,
          manifestMalformed: false,
          orphanTaskRoot: true,
          reason: "Task root has no run subdirectories.",
        });
      }
      continue;
    }

    runDirs.sort();

    for (const runEntry of runDirs) {
      const runDir = join(taskRoot, runEntry);
      const runInfo = await stat(runDir).catch(() => undefined);
      if (!runInfo?.isDirectory()) continue;

      totalRunDirs++;

      if (runs.length >= limit) continue;

      // Parse run.json for age and status info.
      let runMeta: Record<string, unknown> | undefined;
      let runJsonMalformed = false;
      try {
        const raw = await readFile(join(runDir, "run.json"), "utf8");
        runMeta = JSON.parse(raw);
      } catch {
        runJsonMalformed = true;
      }

      // Derive age.
      let ageMs: number;
      if (runMeta && typeof runMeta.createdAt === "string") {
        const parsed = new Date(runMeta.createdAt).getTime();
        ageMs = !isNaN(parsed) ? Math.max(0, nowMs - parsed) : Math.max(0, nowMs - runInfo.mtimeMs);
      } else {
        ageMs = Math.max(0, nowMs - runInfo.mtimeMs);
      }

      // Parse manifest for terminal status.
      let manifestMalformed = false;
      let terminal = false;
      let exitCode: number | null | undefined;
      let timedOut: boolean | undefined;
      try {
        const raw = await readFile(join(runDir, "artifacts", "manifest.json"), "utf8");
        const manifest = JSON.parse(raw);
        exitCode = typeof runMeta?.exitCode === "number" ? runMeta.exitCode : undefined;
        timedOut = runMeta?.timedOut === true || manifest?.timedOut === true;
        const status = inferScanStatus(manifest, exitCode, timedOut);
        terminal = TERMINAL_STATUSES.has(status);
      } catch {
        manifestMalformed = true;
        // If run.json has exitCode or timedOut, we can still infer terminal.
        exitCode = typeof runMeta?.exitCode === "number" ? runMeta.exitCode : undefined;
        timedOut = runMeta?.timedOut === true;
        if (exitCode === 0 || exitCode === 1 || timedOut) terminal = true;
      }

      // Classify the run.
      let status: ReadinessRunStatus;
      let reason: string | undefined;

      if (runJsonMalformed && manifestMalformed) {
        status = "malformed";
        reason = "Both run.json and manifest.json are missing or unparseable.";
        malformedRuns++;
      } else if (runJsonMalformed) {
        status = "malformed";
        reason = "run.json is missing or unparseable.";
        malformedRuns++;
      } else if (manifestMalformed) {
        status = "malformed";
        reason = "manifest.json is missing or unparseable.";
        malformedRuns++;
      } else if (!terminal && ageMs > staleThresholdMs) {
        status = "stale";
        reason = `Run age ${ageMs}ms exceeds stale threshold ${staleThresholdMs}ms without terminal status.`;
        staleRuns++;
      } else {
        status = "ok";
      }

      runs.push({
        safeTaskId: sanitizeScanText(entry, 200),
        runToken: sanitizeScanText(runEntry, 200),
        ageMs,
        status,
        terminal,
        runJsonMalformed,
        manifestMalformed,
        orphanTaskRoot: false,
        ...(reason ? { reason: sanitizeScanText(redactSecrets(reason), 160) } : {}),
      });
    }
  }

  // Deterministic sort by runToken.
  runs.sort((a, b) => a.runToken.localeCompare(b.runToken));

  return {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: sanitizeRootLabel(rootDir),
    totalTaskRoots,
    totalRunDirs,
    staleRuns,
    malformedRuns,
    orphanTaskRoots,
    runs: runs.slice(0, limit),
  };
}

function emptyReadinessReport(rootDir: string): ReadinessReport {
  return {
    schemaVersion: "a2a.runner.readiness-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: sanitizeRootLabel(rootDir),
    totalTaskRoots: 0,
    totalRunDirs: 0,
    staleRuns: 0,
    malformedRuns: 0,
    orphanTaskRoots: 0,
    runs: [],
  };
}
