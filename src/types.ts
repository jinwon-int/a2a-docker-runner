export type RunnerEngine = "docker" | "podman";

// ─────────────────────────────────────────────────────────────────────────────
// Task Templates (Team1 nosuk lane, A2A R23)
// Parent: a2a-docker-runner#261
// Parent: a2a-plane#335
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A reusable task template that can be referenced by name or inlined.
 *
 * Templates support `${variable}` substitution from a task's `templateVars` map.
 * A template can define repos, commands, prompt, env, mode, and other task
 * fields that the runner expands at execution time.
 */
export interface TaskTemplate {
  /** Template identifier (used by RunnerTask.template). */
  id: string;
  /** Semantic version of this template for compatibility checking. */
  version?: string;
  /** Human-readable label. */
  label?: string;
  /** Execution mode (e.g. "github-propose-patch", "github-verify"). */
  mode?: string;
  /** Optional preset. */
  preset?: RunnerPreset;
  /** Repos defined by the template. Tasks may extend these. */
  repos?: RunnerRepo[];
  /** Commands with ${variable} placeholders. */
  commands?: string[];
  /** Template-level prompt text with ${variable} placeholders. */
  prompt?: string;
  /** Default environment variables. */
  env?: Record<string, string>;
  /** Default base branch. */
  baseBranch?: string;
  /** Language hint. */
  reportLanguage?: string;
  /** Default timeout. */
  timeoutMs?: number;
  /** Describes what variables the template expects. */
  requiredVars?: string[];
  /** Describes optional variables and their defaults. */
  optionalVars?: Record<string, string>;
}

/**
 * Template variable values supplied by a task to fill a template.
 * Keys are without the `${}` wrapper. Values are safe, bounded strings.
 */
export type TaskTemplateVars = Record<string, string>;

/**
 * Execution proof produced after a runner task completes.
 *
 * Links the task input, expansion, commands, and output evidence into a
 * deterministic, replay-safe proof that can be independently verified.
 * The proof includes cryptographic digests so consumers can detect tampering
 * or drift.
 */
export interface ExecutionProof {
  /** Canonical schema version. */
  schemaVersion: "a2a.runner.execution-proof.v1";
  /** Task identifier (safeId). */
  taskId: string;
  /** Run token that uniquely identifies this execution. */
  runToken: string;
  /** ISO-8601 timestamp of when the proof was generated. */
  generatedAt: string;
  /** Digest of the normalized task input (before expansion). */
  inputDigest: string;
  /** Digest of the expanded commands and env (after template expansion). */
  expandedDigest: string;
  /** Digest of the container stdout + stderr output (redacted). */
  outputDigest: string;
  /** Digest linking input → expanded → output for tamper evidence. */
  chainDigest: string;
  /** Exit code from the container execution. */
  exitCode: number | null;
  /** Whether the task was successful. */
  ok: boolean;
  /** Task outcome status. */
  status: "completed" | "failed" | "timeout";
  /** URL of the PR created (if applicable). */
  prUrl?: string;
  /** Evidence outcome classification. */
  outcome?: ArtifactManifestStatus | "timed_out" | "missing_evidence" | "failed_infrastructure";
  /** Failure category for stability gates. */
  failureCategory?: string;
  /** Bounded, redacted summary of the execution. */
  summary?: string;
  /** Reference to the artifact manifest path. */
  manifestPath: string;
}

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
export type GitHubEvidenceOutcome =
  | "pr"
  | "done"
  | "block"
  | "budget_limited"
  | "timed_out"
  | "missing_evidence"
  /** Evidence-only / allowNoChanges task completed with Done evidence and no code diff. */
  | "succeeded_no_changes_with_done_evidence"
  /** Evidence-only / allowNoChanges task blocked with Block evidence and no code diff. */
  | "blocked_no_changes_with_evidence"
  /** Container/infrastructure failure (image pull, daemon, mount, etc.), not a no-change or patch failure. */
  | "failed_infrastructure";

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

/** Single entry in the GitHub comment evidence ledger. */
export interface GitHubCommentLedgerEntry {
  /** Stable, replay-safe idempotency key for this comment. */
  dedupeKey: string;
  /** URL of the posted GitHub comment. */
  url: string;
  /** Comment kind. */
  kind: "start" | "block" | "done" | "progress";
  /** ISO-8601 timestamp when the comment was posted. */
  postedAt: string;
}

/**
 * GitHub comment evidence ledger.
 *
 * Comments are evidence ledger entries only — they are NOT ACK, read-receipt,
 * or operator-approval proof.  The ledger is explicitly separate from Terminal
 * Brief ACK/read/visibility decisions and from operator approval.
 *
 * Parent: a2a-plane#204
 */
export interface GitHubCommentLedger {
  /** Canonical ledger schema version. */
  schemaVersion: "a2a.runner.github-comment-ledger.v1";
  /** Ordered list of comment evidence entries. Start comment is first when present. */
  entries: GitHubCommentLedgerEntry[];
  /** Explicit separation: comments are evidence ledger entries, not approval. */
  disclaimer: "GitHub comments are evidence ledger entries, not ACK/read/visibility proof and not approval.";
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
  /** Start comment URL posted at the beginning of the evidence round. */
  startCommentUrl?: string;
  /**
   * GitHub comment evidence ledger.
   * Comments are evidence ledger entries only — not ACK, read-receipt, or
   * operator-approval proof.  Explicitly separate from Terminal Brief
   * ACK/read/visibility decisions.
   *
   * Parent: a2a-plane#204
   */
  commentLedger?: GitHubCommentLedger;
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
  /** Start comment URL for the evidence round, when available. */
  startCommentUrl?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  branch?: string;
  branchUrl?: string;
  failureCategory?: GitHubEvidenceOutcome | "failed" | "exit_nonzero" | "resource_limited" | "no_changes_allowed";
}

export type GitHubCommentProjectionKind = "pr" | "done" | "block";

/**
 * Terminal Brief extension that projects GitHub issue/PR comments as a
 * replay-safe evidence ledger entry. This is intentionally not ACK/read/
 * visibility evidence and never represents operator approval.
 */
export interface GitHubCommentProjection {
  schemaVersion: "a2a.runner.github-comment-projection.v1";
  kind: GitHubCommentProjectionKind;
  url: string;
  issueUrl?: string;
  manifestPath: string;
  dedupeKey: string;
  commentIsTerminalAck: false;
  commentIsVisibilityReceipt: false;
  commentIsOperatorApproval: false;
}

// ── Worker Capacity Evidence ────────────────────────────────────────────
// Parent: a2a-plane#369
// Parent: a2a-docker-runner#284
// Parent: a2a-docker-runner#285

/**
 * Provenance of worker capacity values for scheduling/assignment metadata.
 *
 * Capacity is scheduling and assignment metadata only. It must never be
 * treated as Terminal ACK decision input, operator approval evidence,
 * read/visibility receipt, or provider delivery confirmation.
 *
 * Values from a configured profile or a read-only probe are authoritative.
 * When neither source is available, capacity MUST be represented as
 * "unknown" and the numeric fields omitted.
 *
 * Parent: a2a-plane#369
 */
export type WorkerCapacitySource = "configured_profile" | "readonly_probe" | "unknown";

/**
 * Worker capacity evidence — scheduling/assignment metadata only.
 *
 * This structure conveys worker scheduling and assignment capacity. It is
 * NOT Terminal ACK decision input, operator approval evidence, read/visibility
 * receipt, or provider delivery confirmation.
 *
 * When neither a configured profile nor a read-only probe provides capacity
 * values, `source` MUST be "unknown" and `available`/`total` MUST be omitted.
 *
 * Parent: a2a-plane#369
 * Parent: a2a-docker-runner#284
 * Parent: a2a-docker-runner#285
 */
export interface WorkerCapacityEvidence {
  schemaVersion: "a2a.runner.worker-capacity.v1";
  /** Worker/node identifier. */
  worker: string;
  /** Provenance of the capacity values. */
  source: WorkerCapacitySource;
  /**
   * Number of available (idle/ready) capacity units.
   * Present only when source is "configured_profile" or "readonly_probe".
   */
  available?: number;
  /**
   * Total capacity units.
   * Present only when source is "configured_profile" or "readonly_probe".
   */
  total?: number;
  /** Explicit: scheduling/assignment metadata only, never Terminal ACK decision input. */
  isTerminalAckInput: false;
}

export type SourcePublicApprovalDecision = "GO_CANDIDATE" | "NO_GO" | "NEEDS_OPERATOR_APPROVAL";

/**
 * Deterministic, no-live source-public approval rehearsal evidence.
 *
 * This is an approval packet preview only. It must never execute source-public
 * publication, approval, release, provider sends, Terminal Brief ACKs, DB
 * mutation, or repository visibility changes.
 */
export interface SourcePublicApprovalPacket {
  schemaVersion: "a2a.runner.source-public-approval-packet.v1";
  packetId: string;
  targetRepo: string;
  decision: SourcePublicApprovalDecision;
  dedupeKey: string;
  evidenceBundlePath: "artifacts/manifest.json";
  operatorApprovalRequired: true;
  approvalExecuted: false;
  releaseExecuted: false;
  visibilityChanged: false;
  terminalAckSent: false;
  providerSendPerformed: false;
  dbMutationPerformed: false;
  rollbackPath: string;
  abortPath: string;
}

export interface SourcePublicApprovalRehearsal {
  schemaVersion: "a2a.runner.source-public-approval-rehearsal.v1";
  generatedAt: "1970-01-01T00:00:00.000Z";
  runId?: string;
  decision: SourcePublicApprovalDecision;
  approvalPackets: SourcePublicApprovalPacket[];
  terminalBriefRehearsalOnly: true;
  replayNoDuplicateProof: {
    dedupeKey: string;
    noDuplicatePacketIds: true;
  };
  rollbackAbort: {
    rollbackPath: string;
    abortPath: string;
  };
  safetyGates: {
    operatorApprovalRequired: true;
    sourcePublicExecutionBlocked: true;
    approvalExecuted: false;
    releaseExecuted: false;
    visibilityChanged: false;
    liveProviderSendPerformed: false;
    terminalAckSent: false;
    dbMutationPerformed: false;
  };
}

export type SourcePublicExecutionPreflightMode = "dry_run" | "simulate";
export type SourcePublicExecutionPreflightStatus = "ready_for_operator_approval" | "blocked";

export interface SourcePublicExecutionPlanAction {
  sequence: number;
  id: string;
  label: string;
  targetRepo: string;
  requiresExplicitOperatorApproval: true;
  dryRunOnly: true;
  sideEffectPerformed: false;
}

/**
 * Final source-public execution preflight capsule.
 *
 * This binds an approved source-public approval packet to deterministic
 * scanner/history evidence and produces an operator-gated dry-run/simulate
 * execution plan.  It is still preflight evidence only: no approval,
 * release, visibility change, provider send, Terminal Brief ACK, DB mutation,
 * deployment, restart, or community post has happened.
 */
export interface SourcePublicExecutionPreflight {
  schemaVersion: "a2a.runner.source-public-execution-preflight.v1";
  generatedAt: "1970-01-01T00:00:00.000Z";
  runId?: string;
  mode: SourcePublicExecutionPreflightMode;
  status: SourcePublicExecutionPreflightStatus;
  approvedPacket: {
    schemaVersion: "a2a.runner.source-public-approval-packet.v1";
    packetId: string;
    targetRepo: string;
    decision: SourcePublicApprovalDecision;
    dedupeKey: string;
    evidenceBundlePath: "artifacts/manifest.json";
  };
  scannerHistoryBinding: {
    scanProfileSchemaVersion: "a2a.runner.scan-profile.v1";
    scannerBound: true;
    historyRunCount: number;
    evidenceBundlePath: "artifacts/manifest.json";
    manifestDigest: string;
    historyDigest: string;
  };
  executionPlan: {
    planId: string;
    planDedupeKey: string;
    operatorGate: "explicit_operator_approval_required";
    dryRunOnly: true;
    simulateOnly: boolean;
    liveExecutionBlocked: true;
    approvalExecutionBlocked: true;
    replayProtected: true;
    actions: SourcePublicExecutionPlanAction[];
  };
  replayProtection: {
    idempotencyKey: string;
    inputFingerprint: string;
    replayIndex: number;
    duplicateDetected: boolean;
  };
  rollbackAbortRunbook: {
    rollbackSteps: string[];
    abortSteps: string[];
  };
  preflightFailureSemantics: {
    failClosed: true;
    reasons: string[];
    approvalPacketNotGoCandidate: boolean;
    missingScannerHistory: boolean;
    manifestMismatch: boolean;
  };
  safetyGates: {
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
  /** When true, the no-changes guard must not fail the task.
   *  The runner accepts terminal evidence without PR for audit/preflight/libero lanes. */
  allowNoChanges?: boolean;
  /**
   * Name of a predefined task template to expand.
   * Templates are resolved from the built-in registry or the task's own
   * `inlineTemplate` field.  When set, the runner merges template fields
   * into the task before execution.
   *
   * Parent: a2a-docker-runner#261
   * Parent: a2a-plane#335
   */
  template?: string;
  /**
   * Variable values to interpolate into the referenced or inline template.
   * Keys match `${variable}` placeholders in template commands, prompt, and env.
   *
   * Parent: a2a-docker-runner#261
   */
  templateVars?: TaskTemplateVars;
  /**
   * Inline template definition.  When set, `template` must be absent or match
   * `inlineTemplate.id`.  The runner expands this template with `templateVars`.
   *
   * Parent: a2a-docker-runner#261
   */
  inlineTemplate?: TaskTemplate;
  /**
   * When true, treat the task as a read-only validation/libero lane: patch
   * commands may inspect and test the checkout, but any tracked, staged,
   * uncommitted, or committed repository delta fails closed before PR creation.
   */
  readOnlyValidation?: boolean;
  /** Safe broker/run identifier to carry into release-gate evidence when present. */
  runId?: string;
  /** Safe distributed trace identifier to carry into release-gate evidence when present. */
  traceId?: string;
  /** Parent-broker aggregation id carried by child tasks for Terminal Brief parity. */
  parentRoundId?: string;
  /** Broker that owns/finalizes the parent round. */
  originBrokerId?: string;
  /** Expected number of children in the parent round. */
  parentRoundTotal?: number;
  /** 1-based child order within the parent round. */
  parentRoundOrder?: number;
  /** Cross-broker handoff routing context, when this child was delegated. */
  crossBrokerHandoff?: RunnerCrossBrokerHandoff;
  /** Optional bounded notification/receipt trace metadata supplied by broker/plugin surfaces. */
  receiptTrace?: RunnerReceiptTrace;
  /** Optional execution proof produced by this task (set by the runner after completion). */
  executionProof?: ExecutionProof;
  /** Language hint for comment formatting (e.g. "ko"). */
  reportLanguage?: string;
  /** A2A broker node that requested the task. */
  requestedBy?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Expansion Evidence (Team1 nosuk lane, A2A R23)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evidence that a task template was expanded with specific variable values.
 *
 * Captures the template id, version, resolved variables (without secrets),
 * and digests of the pre-expansion and post-expansion task shapes.
 */
export interface TemplateExpansionEvidence {
  /** Canonical schema version. */
  schemaVersion: "a2a.runner.template-expansion.v1";
  /** Template identifier. */
  templateId: string;
  /** Template version, when available. */
  templateVersion?: string;
  /** Variable keys that were provided (values redacted for safety). */
  varsProvided: string[];
  /** Variable keys declared as required by the template but not provided. */
  varsMissing?: string[];
  /** Optional variable keys with explicit overrides from the task. */
  varsOptional?: string[];
  /** Digest of the task shape before expansion (sha256 hex). */
  preExpandDigest: string;
  /** Digest of the task shape after expansion (sha256 hex). */
  postExpandDigest: string;
}

export interface RunnerCrossBrokerHandoff {
  parentRoundId?: string;
  originBrokerId?: string;
  handoffBrokerId?: string;
  childWorkerId?: string;
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

export type CleanupRehearsalTarget = "broker_db" | "runner_artifacts";
export type CleanupRehearsalMode = "dry_run" | "simulate";
export type CleanupRehearsalStatus = "ready_for_operator_approval" | "blocked";

/**
 * No-live cleanup backup/checkpoint and rollback rehearsal evidence.
 *
 * This is an artifact-bundle capsule for DB lifecycle/safe-prune planning. It
 * must never perform production DB mutation, pruning, migration, deploy/restart,
 * live provider send, or Terminal Brief ACK. Real cleanup execution remains
 * separately operator-approved after checkpoint evidence exists.
 */
export interface CleanupRehearsalEvidence {
  schemaVersion: "a2a.runner.cleanup-rehearsal.v1";
  generatedAt: "1970-01-01T00:00:00.000Z";
  runId?: string;
  target: CleanupRehearsalTarget;
  mode: CleanupRehearsalMode;
  status: CleanupRehearsalStatus;
  planId: string;
  candidateCounts: {
    total: number;
    highRisk: number;
    staleWorkerRows?: number;
    terminalOutboxRows?: number;
    artifactDirs?: number;
  };
  checkpoint: {
    requiredBeforeExecution: true;
    rehearsalOnly: true;
    evidenceBundlePath: "artifacts/manifest.json";
    checkpointId: string;
    backupVerified: false;
  };
  rollback: {
    rehearsed: true;
    rollbackPlanPath: string;
    abortPlanPath: string;
    restoreVerificationRequired: true;
  };
  failClosedReasons: string[];
  safetyGates: {
    explicitOperatorApprovalRequired: true;
    backupCheckpointRequired: true;
    dryRunOnly: true;
    liveExecutionBlocked: true;
    dbMutationPerformed: false;
    prunePerformed: false;
    migrationPerformed: false;
    deployOrRestartPerformed: false;
    liveProviderSendPerformed: false;
    terminalAckSent: false;
  };
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
  /** Optional no-live cleanup backup/checkpoint and rollback rehearsal capsule. */
  cleanupRehearsal?: CleanupRehearsalEvidence;
  /** Compact structured evidence URLs for broker task-report recovery. */
  evidenceHints?: RunnerEvidenceHints;
  /** Optional execution proof linking task input, expansion, and output. */
  executionProof?: ExecutionProof;
  /** First-class Terminal Brief extension for GitHub comment ledger evidence. */
  githubCommentProjection?: GitHubCommentProjection;
  /** Deterministic no-live rehearsal packet/evidence for source-public approval gates. */
  sourcePublicApprovalRehearsal?: SourcePublicApprovalRehearsal;
  /** Final dry-run/simulate preflight plan bound to scanner/history evidence. */
  sourcePublicExecutionPreflight?: SourcePublicExecutionPreflight;
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
  executionProof?: ExecutionProof;
  budget?: RunnerBudgetEvidence;
  receiptTrace?: RunnerReceiptTrace;
  continuation?: RunnerContinuationEvidence;
  cleanupRehearsal?: CleanupRehearsalEvidence;
  evidenceHints?: RunnerEvidenceHints;
  githubCommentProjection?: GitHubCommentProjection;
  sourcePublicApprovalRehearsal?: SourcePublicApprovalRehearsal;
  sourcePublicExecutionPreflight?: SourcePublicExecutionPreflight;
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
  /** Execution proof for this task. */
  executionProof?: ExecutionProof;
  /** Evidence of template expansion when a template was used. */
  templateExpansion?: TemplateExpansionEvidence;
}

// ---- Source-Public Approval Rehearsal ----
// Parent: a2a-docker-runner#185
// Parent: a2a-plane#211

/** Source-public approval rehearsal decision vocabulary. */
export type ApprovalRehearsalDecision =
  | "GO_CANDIDATE"
  | "NO_GO"
  | "NEEDS_OPERATOR_APPROVAL";

/** A single safety gate checked during an approval rehearsal. */
export interface ApprovalRehearsalSafetyGate {
  /** Gate identifier. */
  id: string;
  /** Human-readable label for operator review. */
  label: string;
  /** Whether the gate passed. */
  passed: boolean;
  /** Explanation when gate failed or is uncertain. */
  reason?: string;
}

/** Idempotency proof: ensures the same rehearsal is never executed twice. */
export interface ApprovalRehearsalIdempotencyProof {
  /** Stable, deterministic dedupe key for this rehearsal. */
  dedupeKey: string;
  /** SHA-256-like hex fingerprint of the serialised input (deterministic). */
  inputFingerprint: string;
  /** Always false — this is a rehearsal, never an execution. */
  wasExecuted: false;
  /** Monotonic rehearsal counter; 0 for the first rehearsal of a given dedupeKey. */
  replayIndex: number;
}

// ---- Source-Public Execution Orchestrator ----
// Parent: a2a-docker-runner#189
// Parent: a2a-plane#218

/** Scanner/history binding that anchors an execution plan to a deterministic scan snapshot. */
export interface ScannerHistoryBinding {
  schemaVersion: "a2a.runner.scanner-history-binding.v1";
  /** Stable reference to the scan profile that produced this binding. */
  scanProfileRef: string;
  /** Deterministic timestamp when the binding was created. */
  boundAt: "1970-01-01T00:00:00.000Z";
  /** SHA-256 hex digest of the serialised scan profile for tamper detection. */
  scannerDigest: string;
  /** Number of runs captured in the scan snapshot. */
  historySnapshotSize: number;
  /** Most recent scan outcome for quick operator reference. */
  lastScanOutcome?: string;
  /** Number of historical GO_CANDIDATE packets found during the scan. */
  goCandidateCount?: number;
  /** Number of historical NO_GO / NEEDS_OPERATOR_APPROVAL packets found. */
  blockedCount?: number;
}

/** Options for building an execution plan from an approval rehearsal packet. */
export interface ExecutionOrchestratorOptions {
  /** Safe run identifier from the task payload. */
  runId: string;
  /** Optional safe trace identifier. */
  traceId?: string;
  /** Output directory for writing the execution plan artifacts. */
  outputPath: string;
  /** Replay index for deduplication; 0 for the first attempt. */
  replayIndex?: number;
  /** Optional scanner/history binding produced by a prior scan. */
  scannerHistoryBinding?: ScannerHistoryBinding;
  /** Optional issue URL for evidence hints. */
  issueUrl?: string;
  /** When true, skip plan generation for NO_GO or NEEDS_OPERATOR_APPROVAL packets. */
  requireGoCandidate?: boolean;
}

/** A single preflight check executed against a plan before it can be simulated. */
export interface ExecutionPreflightCheck {
  /** Check identifier (deterministic). */
  checkId: string;
  /** Human-readable label for operator review. */
  label: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Explanation when check failed. */
  reason?: string;
}

/** Preflight result: must pass all checks before an execution plan is considered valid. */
export interface ExecutionPreflightResult {
  /** True when every preflight check passed. */
  passed: boolean;
  /** Ordered list of individual preflight checks. */
  checks: ExecutionPreflightCheck[];
  /** Bounded summary for operator review surfaces. */
  summary: string;
  /**
   * Failure semantics when preflight fails.
   * - "abort_and_report": plan is unsafe; abort and report to operator.
   * - "needs_operator_override": plan has recoverable issues; operator may override.
   */
  failureSemantics: "abort_and_report" | "needs_operator_override";
  /** When passed is false, list of check ids that failed. */
  failedCheckIds: string[];
}

/** A single action in the execution plan. */
export interface PlannedAction {
  /** Deterministic action identifier. */
  actionId: string;
  /** Short description of what this action does. */
  description: string;
  /** Action classification. */
  kind: "git_push" | "pr_create" | "comment_post" | "branch_create" | "code_change" | "artifact_write" | "scan_bind" | "noop";
  /** Target repository when applicable. */
  repo?: string;
  /** Target branch when applicable. */
  branch?: string;
  /** Always blocked or pending — this round never executes. */
  status: "blocked" | "pending_operator_approval";
  /** Corresponding rollback action if this action were executed. */
  rollbackAction?: string;
  /** Preflight checks specific to this action. */
  preflightChecks: ExecutionPreflightCheck[];
}

/** A single step in the rollback runbook. */
export interface RollbackStep {
  /** 1-based step number. */
  step: number;
  /** Action identifier for cross-referencing with planned actions. */
  action: string;
  /** Human-readable description of how to rollback. */
  description: string;
  /** Whether this rollback step is reversible (always true). */
  reversible: boolean;
}

/** Rollback runbook: ordered steps to undo every planned action. */
export interface RollbackRunbook {
  schemaVersion: "a2a.runner.rollback-runbook.v1";
  /** Ordered rollback steps (reverse of execution order). */
  steps: RollbackStep[];
}

/** A single step in the abort runbook. */
export interface AbortStep {
  /** 1-based step number. */
  step: number;
  /** Condition that triggers this abort step. */
  trigger: string;
  /** Human-readable description of the abort action. */
  action: string;
}

/** Abort runbook: documented safe-abort procedures before any side effects. */
export interface AbortRunbook {
  schemaVersion: "a2a.runner.abort-runbook.v1";
  /** Ordered abort steps. */
  steps: AbortStep[];
}

/** Idempotency proof for the execution plan (never executed in this round). */
export interface ExecutionIdempotencyProof {
  /** Stable, deterministic dedupe key. */
  dedupeKey: string;
  /** SHA-256 hex fingerprint of the plan input (deterministic). */
  inputFingerprint: string;
  /** Always false — this round never executes. */
  wasExecuted: false;
  /** Monotonic replay counter. */
  replayIndex: number;
  /** Guarantees no duplicate plan ids in any execution context. */
  noDuplicatePlanIds: true;
}

/** Result of simulating an execution plan in dry-run mode. */
export interface ExecutionSimulateResult {
  /** True when the plan can be safely simulated. */
  ok: boolean;
  /** Number of actions in the simulated plan. */
  actionCount: number;
  /** Number of actions that would change state (non-noop). */
  stateChangingActions: number;
  /** Estimated affected repositories. */
  affectedRepos: string[];
  /** Estimated affected branches. */
  affectedBranches: string[];
  /** Bounded summary of what would happen. */
  summary: string;
  /** Explicit: simulation mode — nothing was executed. */
  simulationOnly: true;
  /** Preflight result embedded for operator review. */
  preflight: ExecutionPreflightResult;
  /** When ok is false, list of blocking reasons. */
  blockingReasons: string[];
}

/** The deterministic execution plan produced from an approved rehearsal packet. */
export interface ExecutionPlan {
  /** Canonical schema version. */
  schemaVersion: "a2a.runner.execution-plan.v1";
  /** Deterministic plan identifier. */
  planId: string;
  /** Deduplication key for replay/no-duplicate guards. */
  dedupeKey: string;
  /** References the rehearsal packet that this plan was built from. */
  packetId: string;
  /** Combined idempotency proof covering both rehearsal and execution. */
  idempotencyProof: ExecutionIdempotencyProof;
  /** Target repository (owner/repo). */
  targetRepo: string;
  /** Ordered list of planned actions. */
  plannedActions: PlannedAction[];
  /** Explicit: this round is always dry-run/simulate only. */
  dryRun: "simulate_only";
  /** Explicit: operator approval is required before any execution. */
  operatorApprovalRequired: true;
  /** Scanner/history binding for evidence chain integrity. */
  scannerHistoryBinding?: ScannerHistoryBinding;
  /** Rollback runbook for every planned action. */
  rollbackRunbook: RollbackRunbook;
  /** Abort runbook for pre-execution and mid-execution failures. */
  abortRunbook: AbortRunbook;
  /** Preflight result embedded in the plan. */
  preflightResult: ExecutionPreflightResult;
  /** Simulate result for dry-run operator review. */
  simulateResult: ExecutionSimulateResult;
  /** Deterministic generation timestamp. */
  generatedAt: "1970-01-01T00:00:00.000Z";
  /** Explicit safety: no execution happened. */
  approvalExecuted: false;
  releaseExecuted: false;
  visibilityChanged: false;
  terminalAckSent: false;
  providerSendPerformed: false;
  dbMutationPerformed: false;
  /** Optional evidence hints for broker/operator recovery. */
  evidenceHints?: RunnerEvidenceHints;
}

/** Replay-safe approval rehearsal packet produced before any real source-public change. */
export interface ApprovalRehearsalPacket {
  /** Canonical schema version. */
  schemaVersion: "a2a.runner.approval-rehearsal.v1";
  /** Deterministic generation timestamp. */
  generatedAt: "1970-01-01T00:00:00.000Z";
  /** Safe run identifier from the task payload. */
  runId: string;
  /** Safe distributed trace identifier. */
  traceId?: string;
  /** Target repository (owner/repo). */
  repo: string;
  /** Target branch. */
  branch?: string;
  /** Short operator-facing description of the proposed change. */
  proposedChange: string;
  /** Safety gate inventory — every gate in this list must pass for GO_CANDIDATE. */
  safetyGates: ApprovalRehearsalSafetyGate[];
  /** Idempotency proof for replay/no-duplicate guards. */
  idempotencyProof: ApprovalRehearsalIdempotencyProof;
  /** Decision output: GO_CANDIDATE, NO_GO, or NEEDS_OPERATOR_APPROVAL. */
  decision: ApprovalRehearsalDecision;
  /** Summary of why the decision was reached. */
  decisionReason: string;
  /** Abort/rollback paths documented for operator reference. */
  abortPaths: string[];
  /** Rollback paths documented for operator reference. */
  rollbackPaths: string[];
  /** Path to the integrated evidence bundle (manifest-relative). */
  evidenceBundlePath: string;
  /** Structured evidence hints for broker/operator recovery. */
  evidenceHints?: RunnerEvidenceHints;
}
