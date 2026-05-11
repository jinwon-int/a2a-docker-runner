import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { RESULT_STREAM_LIMIT, redactSecrets, redactAndBound } from "./runner.js";
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
        return nowMs - createdAtMs;
      }
    }
  } catch {
    // fall through to mtime fallback.
  }
  return nowMs - mtimeMsFallback;
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

  // Build the bundle manifest.
  const bundleManifest: ArtifactManifest = {
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(sourceManifest?.taskId ? { taskId: sourceManifest.taskId } : {}),
    ...(sourceManifest?.repo ? { repo: sourceManifest.repo } : {}),
    ...(sourceManifest?.branch ? { branch: sourceManifest.branch } : {}),
    ...(sourceManifest?.prUrl ? { prUrl: sourceManifest.prUrl } : {}),
    ...(sourceManifest?.issueUrl ? { issueUrl: sourceManifest.issueUrl } : {}),
    status: sourceManifest?.status ?? "done",
    summary: redactAndBound((sourceManifest?.summary ?? "Redacted artifact bundle produced by a2a-docker-runner scanner.").trim(), 300),
    evidence: sourceManifest?.evidence ?? [],
    artifacts: entries,
    ...(evidenceHints ? { evidenceHints } : {}),
    ...(githubCommentProjection ? { githubCommentProjection } : {}),
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
