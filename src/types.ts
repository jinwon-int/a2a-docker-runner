export type RunnerEngine = "docker" | "podman";

export interface RunnerConfig {
  rootDir: string;
  engine?: RunnerEngine;
  image: string;
  /** Safe runner build/source metadata propagated to containers and evidence. */
  buildMetadata?: RunnerBuildMetadata;
  githubTokenFile?: string;
  defaultTimeoutMs: number;
  memory?: string;
  cpus?: string;
  /** Container network mode. Defaults to bridge; OpenClaw profile uses host to reach the local gateway. */
  network?: string;
  /** Additional host paths to mount into the runner container. */
  extraMounts?: RunnerExtraMount[];
  /**
   * Escape hatch for github-propose-patch/propose_patch mode.
   * When set, injected as A2A_PATCH_COMMAND env var into containers.
   * Default commands for patch mode reference this to invoke a coding agent.
   *
   * @deprecated Prefer commandScript (safer, no eval) or commandArgv.
   *             This path uses eval and will emit a deprecation notice.
   */
  commandTemplate?: string;

  /**
   * Safe script file content for patch command execution.
   * Runner writes this to /work/patch-command.sh in the container.
   * This is the recommended path — no eval, no shell injection risk.
   */
  commandScript?: string;

  /**
   * JSON-encoded argv/env for safe patch command execution.
   * Format: { "argv": ["codex", "exec", "..."], "env": { "KEY": "val" } }
   * Runner serialises this into a safe script, avoiding eval.
   */
  commandJson?: string;
}

export interface RunnerBuildMetadata {
  version?: string;
  source?: string;
  revision?: string;
  builtAt?: string;
  image?: string;
}

export interface RunnerExtraMount {
  /** Absolute host path. */
  source: string;
  /** Absolute container path. */
  target: string;
  /** Defaults to true; set false only for explicitly writable scratch mounts. */
  readOnly?: boolean;
}

export type RunnerPreset = "openclaw-plugin-a2a-dev";

export interface RunnerRepo {
  /** Logical name used for artifact summaries. */
  name?: string;
  /** Git remote URL or GitHub shorthand such as "jinwon-int/openclaw-plugin-a2a". */
  url: string;
  /** Checkout branch/tag/ref. Defaults to main. */
  branch?: string;
  /** Container path under /work. Defaults to repo name. */
  path?: string;
  /** Mark as the task's main repo for default command generation. */
  primary?: boolean;
}

/** GitHub-mode completion evidence produced by the executor contract. */
export type GitHubEvidenceOutcome = "pr" | "done" | "block" | "budget_limited" | "timed_out" | "missing_evidence";

export interface GitHubValidationSummary {
  status: RunnerResult["status"];
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  timedOut: boolean;
  artifactCount: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface GitHubEvidenceSafetyState {
  /** Runner/operator closeout did not perform a live provider send. */
  noLiveProviderSend: true;
  /** Terminal outbox ACK is never implied by provider send or PR/Done/Block evidence. */
  terminalAck: "not_attempted" | "requires_operator_receipt";
  /** Provider delivery/send success is not operator receipt evidence. */
  providerSendIsReceiptEvidence: false;
}

export interface GitHubEvidence {
  /** Canonical structured evidence envelope version for GitHub patch task closeout. */
  schemaVersion?: "a2a.runner.github-evidence.v1";
  repo?: string;
  issue?: string;
  /** Canonical GitHub issue URL required by receipt-gated terminal/operator evidence. */
  issueUrl?: string;
  taskId?: string;
  /** Worker/requesting node that produced or requested this evidence. */
  worker?: string;
  issueTitle?: string;
  taskBrief?: string;
  outcome?: GitHubEvidenceOutcome;
  /** PR URL when a patch was successfully proposed (e.g. git push + gh pr create). */
  prUrl?: string;
  /** Canonical Block URL. Backward-compatible alias: blockCommentUrl. */
  blockUrl?: string;
  /** Canonical Done URL. Backward-compatible alias: doneCommentUrl. */
  doneUrl?: string;
  /** Block comment URL posted when the task is impossible or unsafe. */
  blockCommentUrl?: string;
  /** Done comment URL for tasks that complete without a PR. */
  doneCommentUrl?: string;
  validation?: GitHubValidationSummary;
  /** Explicit no-live/no-ACK safety state for receipt-gated Terminal Brief lanes. */
  safetyState?: GitHubEvidenceSafetyState;
  /** Safe broker/run identifier, included when supplied by the task payload/env. */
  runId?: string;
  /** Safe distributed trace identifier, included when supplied by the task payload/env. */
  traceId?: string;
  /** Release-gate validation errors; any entry means the evidence must fail closed. */
  validationErrors?: string[];
  commit?: string;
  branch?: string;
}

/** Compact, broker-safe pointers that can be recovered from artifacts/result summaries. */
export interface RunnerEvidenceHints {
  schemaVersion: "a2a.runner.evidence-hints.v1";
  issueUrl?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  branch?: string;
  branchUrl?: string;
  failureCategory?: GitHubEvidenceOutcome | "failed" | "exit_nonzero";
}

export interface RunnerTask {
  id: string;
  intent: string;
  /** Execution mode. "github-propose-patch" activates the GitHub evidence contract. */
  mode?: string;
  /** Optional preset that expands into default repos/commands. */
  preset?: RunnerPreset;
  /** Backward-compatible single repo input. */
  repo?: string;
  baseBranch?: string;
  /** Multi-repo checkouts for plugin/openclaw/broker integration jobs. */
  repos?: RunnerRepo[];
  /** Shell commands executed inside the container after checkout. */
  commands?: string[];
  prompt?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  issue?: string | number;
  issueNumber?: string | number;
  /** GitHub issue URL for evidence-mode Block/Done comment posting. */
  issueUrl?: string;
  /** Safe issue title supplied by the broker for terminal/operator evidence. */
  issueTitle?: string;
  /** Safe one-line task brief supplied by the broker for terminal/operator evidence. */
  taskBrief?: string;
  /** Existing PR URL for closeout/comment-only evidence tasks. */
  existingPrUrl?: string;
  /** Existing PR number; used with repo to derive existingPrUrl when provided by broker payloads. */
  existingPrNumber?: string | number;
  /** When true, the default GitHub pipeline must not create a new PR. */
  forbidNewPr?: boolean;
  /** When true, skip patch execution and finish with Done/Block comment-only evidence. */
  commentOnly?: boolean;
  /** Safe broker/run identifier to carry into release-gate evidence when present. */
  runId?: string;
  /** Safe distributed trace identifier to carry into release-gate evidence when present. */
  traceId?: string;
  /** Optional bounded notification/receipt trace metadata supplied by broker/plugin surfaces. */
  receiptTrace?: RunnerReceiptTrace;
  /** Language hint for comment formatting (e.g. "ko"). */
  reportLanguage?: string;
  /** A2A broker node that requested the task. */
  requestedBy?: string;
}

export interface NormalizedRunnerTask extends RunnerTask {
  repos: RunnerRepo[];
  commands: string[];
}

export interface ArtifactManifestEntry {
  /** Artifact path relative to the task workDir. */
  path: string;
  /** Basename for quick display. */
  name: string;
  /** File size in bytes. */
  sizeBytes: number;
}

export type ArtifactManifestStatus = "done" | "blocked" | "failed" | "budget_limited";
export type RunnerArtifactContractStatus = ArtifactManifestStatus;
export type RunnerBudgetLimitKind = "time" | "token" | "attempt" | "command" | "safety";
export type ArtifactEvidenceKind = "log" | "test" | "diff" | "file";
export type ArtifactEvidenceStatus = "passed" | "failed" | "blocked" | "unknown";
export type RunnerReceiptTraceStatus =
  | "pending"
  | "accepted"
  | "started"
  | "produced"
  | "provider_sent"
  | "operator_visible"
  | "operator_confirmed"
  | "provider_delivery_receipt"
  | "timed_out"
  | "stale"
  | "failed"
  | "receipt_confirmed";
export type RunnerReceiptEvidence = "operator_visible" | "operator_confirmed" | "provider_delivery_receipt";

export interface RunnerBudgetEvidence {
  limitKind: RunnerBudgetLimitKind;
  /** Sanitized operator-facing budget limit, e.g. "45m" or "max_attempts=3". */
  limit?: string;
  /** Sanitized operator-facing usage, e.g. "44m" or "attempts=3". */
  used?: string;
  /** Short, secret-free reason for the limit stop. */
  reason?: string;
}

export interface RunnerReceiptTrace {
  /** Stable bounded receipt trace envelope for broker/plugin receipt-gap reporting. */
  schemaVersion?: "a2a.runner.receipt-trace.v1";
  /** Broker task.terminal outbox/event identifier, if known. */
  outboxId?: string;
  /** Stable notifier event id, if known. */
  notificationId?: string;
  /** Safe notifier dedupe key used to correlate retries without raw payloads. */
  dedupeKey?: string;
  /** Delivery channel label such as "telegram" or "openclaw". */
  channel?: string;
  /** Small receipt state vocabulary; send/provider success is not receipt confirmation. */
  status?: RunnerReceiptTraceStatus;
  /** Valid ACK evidence class when a receipt is actually confirmed. */
  evidence?: RunnerReceiptEvidence;
  /** Provider/operator receipt identifier; never a raw message body. */
  receiptId?: string;
  acknowledgedAt?: string;
  updatedAt?: string;
  attemptCount?: number;
  staleAfterMs?: number;
  /** Bounded, redacted reason for pending/stale/failed reports. */
  reason?: string;
}

export interface RunnerContinuationEvidence {
  /** True when another bounded, explicitly-approved task is the safe next step. */
  recommended: boolean;
  /** Sanitized next prompt for a follow-up task; never auto-executed by the runner. */
  nextPrompt?: string;
  /** Continuation must require operator/broker approval; no unbounded auto-continuation. */
  requiresApproval: true;
}

export interface ArtifactEvidencePart {
  /** Protocol-friendly Part kind for rendering summaries without reading raw logs. */
  kind: ArtifactEvidenceKind;
  /** Short operator label such as "summary.txt" or "npm test". */
  label: string;
  status?: ArtifactEvidenceStatus;
  /** Artifact path relative to the task workDir when the evidence comes from a file. */
  path?: string;
  /** Bounded, redacted preview suitable for public demos and broker/plugin cards. */
  excerpt?: string;
}

export interface ArtifactManifest {
  /** Stable public artifact manifest contract version. */
  artifactVersion: 1;
  /** Backward-compatible alias retained for older runner consumers. */
  schemaVersion: 1;
  /** Path to the emitted manifest.json relative to the task workDir. */
  manifestPath: string;
  /** Fixed timestamp keeps manifest content deterministic for identical artifacts. */
  generatedAt: string;
  taskId?: string;
  repo?: string;
  branch?: string;
  prUrl?: string;
  issueUrl?: string;
  /** Task outcome surfaced by artifact producers; budget_limited is not Done. */
  status: RunnerArtifactContractStatus;
  /** Non-empty, bounded summary for broker/plugin/demo surfaces. */
  summary: string;
  /** A2A Artifact.parts projection of runner evidence. */
  evidence: ArtifactEvidencePart[];
  /** File inventory backing the evidence parts. */
  artifacts: ArtifactManifestEntry[];
  /** Optional sanitized evidence describing which budget stopped the task. */
  budget?: RunnerBudgetEvidence;
  /** Optional sanitized notification/receipt correlation metadata for receipt-gap reports. */
  receiptTrace?: RunnerReceiptTrace;
  /** Optional sanitized recommendation for a bounded, approval-gated continuation. */
  continuation?: RunnerContinuationEvidence;
  /** Compact structured evidence URLs for broker task-report recovery. */
  evidenceHints?: RunnerEvidenceHints;
}

export interface ResultSummary {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactCount: number;
  manifestPath: string;
  /** Bounded, secret-free runner build metadata suitable for broker/operator evidence. */
  runnerBuild?: RunnerBuildMetadata;
  /** Optional artifact-contract outcome; budget_limited is handled as blocked/needs continuation. */
  status?: RunnerArtifactContractStatus;
  budget?: RunnerBudgetEvidence;
  receiptTrace?: RunnerReceiptTrace;
  continuation?: RunnerContinuationEvidence;
  evidenceHints?: RunnerEvidenceHints;
}

export interface RunnerResult {
  ok: boolean;
  taskId: string;
  status: "completed" | "failed" | "timeout";
  workDir: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  /** Structured manifest for artifacts emitted by this execution. */
  artifactManifest?: ArtifactManifest;
  /** Bounded/redacted payload-safe result summary. */
  resultSummary?: ResultSummary;
  /** Bounded, secret-free runner build metadata. Prefer resultSummary.runnerBuild for evidence payloads. */
  runnerBuild?: RunnerBuildMetadata;
  /** @deprecated Prefer github.prUrl for structured evidence. */
  prUrl?: string;
  error?: string;
  /** Structured GitHub evidence for propose_patch / github-propose-patch mode. */
  github?: GitHubEvidence;
}
