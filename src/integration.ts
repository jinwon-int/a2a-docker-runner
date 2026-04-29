/**
 * Integration seam: openclaw-a2a-worker handler → a2a-docker-runner.
 *
 * The worker handler at /opt/openclaw-a2a-worker/handlers/openclaw-a2a-task-handler.mjs
 * calls these helpers to route github-propose-patch / propose_patch tasks into
 * container-isolated execution instead of mutating the host workspace directly.
 *
 * Broker claim/heartbeat logic is NOT touched by this module.
 */

import type { ArtifactManifest, GitHubEvidence, ResultSummary, RunnerTask } from "./types.js";

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
  baseBranch?: string;
  title?: string;
  focus?: string;
  acceptance?: string;
  prompt?: string;
  timeoutMs?: number;
  runnerPreset?: string;
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
  /** Raw runner stdout JSON (for debugging). */
  runnerRaw?: Record<string, unknown>;
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
    reportLanguage: "ko",
    requestedBy: undefined,
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
  // Runner already produced structured evidence (github property)
  if (result.github) {
    const g = result.github;
    if (g.prUrl) return { prUrl: g.prUrl };
    if (g.blockCommentUrl) return { blockCommentUrl: g.blockCommentUrl };
    if (g.doneCommentUrl) return { doneCommentUrl: g.doneCommentUrl };
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
    return {
      status: "blocked",
      summary: `Docker runner completed without PR/Done/Block evidence — task ${task?.id ?? "unknown"}`,
      tests: [],
      filesChanged: resultFilesChanged(result),
      risks: ["runner completed without structured GitHub evidence"],
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
    runnerRaw: brokerFacingRunnerRaw(result),
  };
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
  if (!result.resultSummary) {
    return result as unknown as Record<string, unknown>;
  }

  return {
    ...result,
    stdout: result.resultSummary.stdout,
    stderr: result.resultSummary.stderr,
    artifacts: resultFilesChanged(result),
  } as unknown as Record<string, unknown>;
}

function normalizeString(value?: string): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
