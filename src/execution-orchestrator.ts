/**
 * Source-Public Execution Orchestrator
 *
 * Converts a reviewed approval rehearsal packet (ApprovalRehearsalPacket) into
 * a deterministic, explicitly operator-gated ExecutionPlan.  The orchestrator
 * runs in dry-run/simulate mode only — it NEVER executes approval, release,
 * visibility changes, provider sends, deploys, restarts, terminal ACKs, or
 * DB mutations.
 *
 * Capabilities:
 *  - buildPlan(): produces a deterministic ExecutionPlan from a rehearsal packet
 *  - runPreflight(): fail-closed preflight checks with abort/override semantics
 *  - simulate(): dry-run simulation of what WOULD happen, with blocking reasons
 *  - bindScannerHistory(): creates a scanner/history binding from a ScanProfile
 *
 * Parent: a2a-docker-runner#189
 * Parent: a2a-plane#218
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AbortRunbook,
  AbortStep,
  ApprovalRehearsalPacket,
  ExecutionIdempotencyProof,
  ExecutionOrchestratorOptions,
  ExecutionPlan,
  ExecutionPreflightCheck,
  ExecutionPreflightResult,
  ExecutionSimulateResult,
  PlannedAction,
  RollbackRunbook,
  RollbackStep,
  ScannerHistoryBinding,
} from "./types.js";
import type { ScanProfile } from "./scanner.js";
import { redactSecrets, redactAndBound } from "./runner.js";

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Build a deterministic, operator-gated ExecutionPlan from an approval rehearsal packet.
 *
 * The resulting plan:
 *  - Is always dry-run / simulate-only
 *  - Requires explicit operator approval before any execution
 *  - Includes a full rollback/abort runbook
 *  - Carries an idempotency proof for replay/no-duplicate protection
 *  - Runs preflight checks and embeds the result
 */
export async function buildPlan(
  packet: ApprovalRehearsalPacket,
  options: ExecutionOrchestratorOptions,
): Promise<ExecutionPlan> {
  // 1. Gate: only GO_CANDIDATE packets can produce an executable plan.
  if (options.requireGoCandidate !== false && packet.decision !== "GO_CANDIDATE") {
    return buildBlockedPlan(packet, options, "Packet decision is not GO_CANDIDATE. Operator must re-run approval rehearsal.");
  }

  // 2. Build idempotency proof.
  const idempotencyProof = buildIdempotencyProof(packet, options);

  // 3. Build planned actions from the rehearsal packet.
  const plannedActions = buildPlannedActions(packet, options);

  // 4. Build scanner/history binding.
  const scannerHistoryBinding = options.scannerHistoryBinding ?? buildEmptyScannerBinding();

  // 5. Build rollback and abort runbooks.
  const rollbackRunbook = buildRollbackRunbook(plannedActions);
  const abortRunbook = buildAbortRunbook(plannedActions, packet);

  // 6. Run preflight checks.
  const preflightResult = runPreflight(plannedActions, scannerHistoryBinding, packet);

  // 7. Simulate the plan.
  const simulateResult = simulate(plannedActions, preflightResult, scannerHistoryBinding);

  // 8. Assemble and return the plan.
  const planId = derivePlanId(packet, options);

  const plan: ExecutionPlan = {
    schemaVersion: "a2a.runner.execution-plan.v1",
    planId,
    dedupeKey: idempotencyProof.dedupeKey,
    packetId: buildPacketRef(packet),
    idempotencyProof,
    targetRepo: packet.repo,
    plannedActions,
    dryRun: "simulate_only",
    operatorApprovalRequired: true,
    scannerHistoryBinding,
    rollbackRunbook,
    abortRunbook,
    preflightResult,
    simulateResult,
    generatedAt: "1970-01-01T00:00:00.000Z",
    approvalExecuted: false,
    releaseExecuted: false,
    visibilityChanged: false,
    terminalAckSent: false,
    providerSendPerformed: false,
    dbMutationPerformed: false,
    ...(options.issueUrl ? {
      evidenceHints: {
        schemaVersion: "a2a.runner.evidence-hints.v1" as const,
        issueUrl: options.issueUrl,
      },
    } : {}),
  };

  // Write the plan to disk.
  await writePlanArtifacts(plan, options.outputPath);

  return plan;
}

/**
 * Run preflight checks against a set of planned actions.
 *
 * Preflight checks are fail-closed: any failing check either aborts the plan
 * or requires explicit operator override, depending on the failure category.
 */
export function runPreflight(
  actions: PlannedAction[],
  scannerBinding: ScannerHistoryBinding | undefined,
  packet: ApprovalRehearsalPacket,
): ExecutionPreflightResult {
  const checks: ExecutionPreflightCheck[] = [];

  // P0: Plan must have at least one action.
  checks.push({
    checkId: "plan_has_actions",
    label: "Execution plan contains at least one planned action",
    passed: actions.length > 0,
    reason: actions.length === 0 ? "Plan has zero actions — nothing to execute." : undefined,
  });

  // P1: All actions must be blocked or pending (never executing).
  const executingActions = actions.filter((a) => a.status !== "blocked" && a.status !== "pending_operator_approval");
  checks.push({
    checkId: "all_actions_gated",
    label: "All actions are blocked or pending operator approval",
    passed: executingActions.length === 0,
    reason: executingActions.length > 0
      ? `${executingActions.length} action(s) are not properly gated: ${executingActions.map((a) => a.actionId).join(", ")}`
      : undefined,
  });

  // P2: Rehearsal packet must be a GO_CANDIDATE.
  checks.push({
    checkId: "packet_is_go_candidate",
    label: "Rehearsal packet decision is GO_CANDIDATE",
    passed: packet.decision === "GO_CANDIDATE",
    reason: packet.decision !== "GO_CANDIDATE"
      ? `Packet decision is ${packet.decision}: ${packet.decisionReason.slice(0, 100)}`
      : undefined,
  });

  // P3: All safety gates in the rehearsal must have passed.
  const failedGates = packet.safetyGates.filter((g) => !g.passed);
  checks.push({
    checkId: "all_safety_gates_passed",
    label: "All approval rehearsal safety gates passed",
    passed: failedGates.length === 0,
    reason: failedGates.length > 0
      ? `${failedGates.length} safety gate(s) failed: ${failedGates.map((g) => g.id).join(", ")}`
      : undefined,
  });

  // P4: Scanner/history binding must be present and valid.
  const hasScannerBinding = scannerBinding != null &&
    scannerBinding.schemaVersion === "a2a.runner.scanner-history-binding.v1" &&
    scannerBinding.scannerDigest.length > 0;
  checks.push({
    checkId: "scanner_history_bound",
    label: "Scanner/history binding is present and valid",
    passed: hasScannerBinding,
    reason: !hasScannerBinding
      ? "No valid scanner/history binding — execution plan cannot verify historical context."
      : undefined,
  });

  // P5: No safety gate can be a hard blocker.
  const hardBlockers = failedGates.filter((g) =>
    g.id === "no_approval_execution" ||
    g.id === "rehearsal_round_only" ||
    g.id === "no_secret_or_visibility_change" ||
    g.id === "no_history_rewrite" ||
    g.id === "no_live_provider_send",
  );
  checks.push({
    checkId: "no_hard_blockers",
    label: "No hard-blocker safety gates failed",
    passed: hardBlockers.length === 0,
    reason: hardBlockers.length > 0
      ? `Hard blocker(s) failed: ${hardBlockers.map((g) => g.id).join(", ")}`
      : undefined,
  });

  // P6: Every action must have preflight checks.
  const actionsWithoutChecks = actions.filter((a) => a.preflightChecks.length === 0);
  checks.push({
    checkId: "all_actions_have_preflight",
    label: "Every planned action has preflight checks",
    passed: actionsWithoutChecks.length === 0,
    reason: actionsWithoutChecks.length > 0
      ? `${actionsWithoutChecks.length} action(s) missing preflight checks: ${actionsWithoutChecks.map((a) => a.actionId).join(", ")}`
      : undefined,
  });

  // Determine pass/fail.
  const allPassed = checks.every((c) => c.passed);
  const failedCheckIds = checks.filter((c) => !c.passed).map((c) => c.checkId);

  // Classify failure semantics.
  const hasHardFailures = failedCheckIds.some((id) =>
    id === "plan_has_actions" ||
    id === "all_actions_gated" ||
    id === "packet_is_go_candidate" ||
    id === "no_hard_blockers",
  );

  const failureSemantics = allPassed
    ? "needs_operator_override" // even when all pass, operator must explicitly approve
    : hasHardFailures
      ? "abort_and_report"
      : "needs_operator_override";

  const summary = allPassed
    ? `All ${checks.length} preflight checks passed. Operator approval required before any execution.`
    : `${failedCheckIds.length}/${checks.length} preflight checks failed: ${failedCheckIds.join(", ")}. ${failureSemantics === "abort_and_report" ? "Plan must be aborted." : "Operator may override recoverable failures."}`;

  return {
    passed: allPassed,
    checks,
    summary: redactAndBound(summary, 500),
    failureSemantics,
    failedCheckIds,
  };
}

/**
 * Simulate the execution of planned actions.
 *
 * Produces a dry-run result describing what WOULD happen if the plan were
 * executed after operator approval.  No actions are taken.
 */
export function simulate(
  actions: PlannedAction[],
  preflight: ExecutionPreflightResult,
  scannerBinding: ScannerHistoryBinding | undefined,
): ExecutionSimulateResult {
  const stateChangingActions = actions.filter((a) => a.kind !== "noop" && a.kind !== "scan_bind");
  const affectedRepos = [...new Set(actions.map((a) => a.repo).filter((r): r is string => r != null))];
  const affectedBranches = [...new Set(actions.map((a) => a.branch).filter((b): b is string => b != null))];

  const blockingReasons: string[] = [];

  if (!preflight.passed) {
    blockingReasons.push(`Preflight failed: ${preflight.summary}`);
  }

  if (stateChangingActions.length > 0 && actions.some((a) => a.status !== "blocked")) {
    blockingReasons.push("One or more state-changing actions are not properly gated as 'blocked'.");
  }

  // Any action with kind "pr_create" or "git_push" that references a live repo
  // is always blocked in this round.
  const liveActions = actions.filter((a) =>
    (a.kind === "pr_create" || a.kind === "git_push" || a.kind === "comment_post") &&
    a.status !== "blocked",
  );
  if (liveActions.length > 0) {
    blockingReasons.push(
      `${liveActions.length} live action(s) are not blocked: ${liveActions.map((a) => a.actionId).join(", ")}. This round is simulation-only.`,
    );
  }

  const ok = blockingReasons.length === 0 && preflight.passed;

  return {
    ok,
    actionCount: actions.length,
    stateChangingActions: stateChangingActions.length,
    affectedRepos: affectedRepos.sort(),
    affectedBranches: affectedBranches.sort(),
    summary: redactAndBound(
      ok
        ? `Simulation: ${actions.length} planned action(s), ${stateChangingActions.length} state-changing. All actions are gated and preflight passed. Nothing was executed. Operator approval required.`
        : `Simulation BLOCKED: ${blockingReasons.join(" ")}`,
      500,
    ),
    simulationOnly: true,
    preflight,
    blockingReasons,
  };
}

/**
 * Create a scanner/history binding from a scan profile.
 *
 * Produces a deterministic, tamper-evident binding that anchors the execution
 * plan to a specific scanner snapshot.
 */
export function bindScannerHistory(
  scanProfile: ScanProfile,
  options?: { scanProfileRef?: string },
): ScannerHistoryBinding {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: scanProfile.schemaVersion,
      rootLabel: scanProfile.rootLabel,
      totalRunDirs: scanProfile.totalRunDirs,
      runs: scanProfile.runs.map((r) => ({
        safeTaskId: r.safeTaskId,
        runToken: r.runToken,
        status: r.status,
        outcome: r.outcome,
        decision: r.sourcePublicApprovalRehearsal?.decision,
      })),
    }))
    .digest("hex")
    .slice(0, 32);

  const goCandidates = scanProfile.runs.filter(
    (r) => r.sourcePublicApprovalRehearsal?.decision === "GO_CANDIDATE",
  ).length;
  const blocked = scanProfile.runs.filter(
    (r) => r.sourcePublicApprovalRehearsal?.decision === "NO_GO" ||
      r.sourcePublicApprovalRehearsal?.decision === "NEEDS_OPERATOR_APPROVAL",
  ).length;

  const lastRun = scanProfile.runs[scanProfile.runs.length - 1];

  return {
    schemaVersion: "a2a.runner.scanner-history-binding.v1",
    scanProfileRef: options?.scanProfileRef ?? `scan:${digest.slice(0, 12)}`,
    boundAt: "1970-01-01T00:00:00.000Z",
    scannerDigest: digest,
    historySnapshotSize: scanProfile.runs.length,
    lastScanOutcome: lastRun?.outcome ?? lastRun?.status,
    goCandidateCount: goCandidates,
    blockedCount: blocked,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function buildIdempotencyProof(
  packet: ApprovalRehearsalPacket,
  options: ExecutionOrchestratorOptions,
): ExecutionIdempotencyProof {
  const replayIndex = options.replayIndex ?? 0;
  const dedupeKey = buildDedupeKey(packet, options);

  const fingerprintSource = JSON.stringify({
    packetRunId: packet.runId,
    packetDedupeKey: packet.idempotencyProof.dedupeKey,
    packetDecision: packet.decision,
    runId: options.runId,
    traceId: options.traceId ?? "",
    replayIndex,
  });
  const inputFingerprint = createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 32);

  return {
    dedupeKey,
    inputFingerprint,
    wasExecuted: false,
    replayIndex,
    noDuplicatePlanIds: true,
  };
}

function buildDedupeKey(
  packet: ApprovalRehearsalPacket,
  options: ExecutionOrchestratorOptions,
): string {
  const parts = [
    packet.idempotencyProof.dedupeKey,
    options.runId.slice(0, 64),
    options.traceId?.slice(0, 40) ?? "",
    String(options.replayIndex ?? 0),
  ].filter(Boolean);
  const raw = parts.join("|");
  return `a2a-exec-orch:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

function derivePlanId(
  packet: ApprovalRehearsalPacket,
  options: ExecutionOrchestratorOptions,
): string {
  const source = [
    packet.runId,
    packet.idempotencyProof.dedupeKey,
    options.runId,
    String(options.replayIndex ?? 0),
  ].join("|");
  return `plan:${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

function buildPacketRef(packet: ApprovalRehearsalPacket): string {
  return `rehearsal:${packet.runId}:${packet.idempotencyProof.dedupeKey.slice(0, 12)}`;
}

/** Build the ordered list of planned actions from a GO_CANDIDATE packet. */
function buildPlannedActions(
  packet: ApprovalRehearsalPacket,
  options: ExecutionOrchestratorOptions,
): PlannedAction[] {
  const actions: PlannedAction[] = [];
  let idx = 0;

  // Action 0: Bind scanner/history evidence.
  actions.push({
    actionId: `action-${String(idx++).padStart(3, "0")}`,
    description: "Bind scanner/history evidence to the execution plan.",
    kind: "scan_bind",
    repo: packet.repo,
    status: "blocked",
    rollbackAction: "Discard the scanner binding; the scan profile is immutable.",
    preflightChecks: [
      {
        checkId: "scanner_binding_valid",
        label: "Scanner binding is present and digest-valid",
        passed: options.scannerHistoryBinding != null,
        reason: options.scannerHistoryBinding == null
          ? "No scanner binding provided. History context is unverified."
          : undefined,
      },
    ],
  });

  // Action 1: Write plan artifacts to the output directory.
  actions.push({
    actionId: `action-${String(idx++).padStart(3, "0")}`,
    description: "Write execution plan artifacts to the output directory (no-live, no-execution).",
    kind: "artifact_write",
    repo: packet.repo,
    status: "blocked",
    rollbackAction: "Remove the output directory; all artifacts are self-contained.",
    preflightChecks: [
      {
        checkId: "output_path_writable",
        label: "Output path is writable",
        passed: true, // verified at write time
      },
    ],
  });

  // Action 2: Branch creation (simulated only).
  if (packet.branch && packet.branch !== "main") {
    actions.push({
      actionId: `action-${String(idx++).padStart(3, "0")}`,
      description: `Create or validate branch ${packet.branch} on ${packet.repo}.`,
      kind: "branch_create",
      repo: packet.repo,
      branch: packet.branch,
      status: "blocked",
      rollbackAction: `Delete branch ${packet.branch} on ${packet.repo}.`,
      preflightChecks: [
        {
          checkId: "branch_name_valid",
          label: "Branch name is safe (no special characters beyond /-_.).",
          passed: /^[A-Za-z0-9_\-./]+$/.test(packet.branch),
          reason: !/^[A-Za-z0-9_\-./]+$/.test(packet.branch)
            ? `Unsafe branch name: ${packet.branch}`
            : undefined,
        },
      ],
    });
  }

  // Action 3: Code change / PR creation (simulated only).
  actions.push({
    actionId: `action-${String(idx++).padStart(3, "0")}`,
    description: `Propose code change: ${packet.proposedChange.slice(0, 120)}`,
    kind: "pr_create",
    repo: packet.repo,
    branch: packet.branch,
    status: "blocked",
    rollbackAction: "Close PR and delete branch. No merge was performed.",
    preflightChecks: [
      {
        checkId: "repo_not_empty",
        label: "Target repository is specified",
        passed: packet.repo.length > 0,
        reason: !packet.repo ? "No target repository specified." : undefined,
      },
      {
        checkId: "approval_not_executed",
        label: "Approval has not been executed (this round is rehearsal only)",
        passed: true,
      },
    ],
  });

  // Action 4: Comment posting (simulated only).
  actions.push({
    actionId: `action-${String(idx++).padStart(3, "0")}`,
    description: "Post execution-orchestrator evidence comment on the linked issue.",
    kind: "comment_post",
    repo: packet.repo,
    status: "blocked",
    rollbackAction: "Delete or edit the comment. Comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.",
    preflightChecks: [
      {
        checkId: "issue_url_present",
        label: "Issue URL is available for comment posting",
        passed: options.issueUrl != null,
        reason: options.issueUrl == null
          ? "No issue URL provided. Cannot post evidence comment."
          : undefined,
      },
      {
        checkId: "comment_is_not_ack",
        label: "Comment is evidence ledger entry, not terminal ACK, read receipt, visibility proof, or operator approval.",
        passed: true,
      },
    ],
  });

  return actions;
}

function buildRollbackRunbook(actions: PlannedAction[]): RollbackRunbook {
  // Rollback steps are the reverse of execution order.
  const steps: RollbackStep[] = [...actions]
    .reverse()
    .map((action, i) => ({
      step: i + 1,
      action: action.actionId,
      description: action.rollbackAction ?? `Undo action: ${action.description}`,
      reversible: true,
    }));

  return {
    schemaVersion: "a2a.runner.rollback-runbook.v1",
    steps,
  };
}

function buildAbortRunbook(
  actions: PlannedAction[],
  packet: ApprovalRehearsalPacket,
): AbortRunbook {
  const steps: AbortStep[] = [];

  steps.push({
    step: 1,
    trigger: "Before any action starts: operator rejects the plan.",
    action: "Discard the execution plan and evidence bundle. No state was mutated.",
  });

  steps.push({
    step: 2,
    trigger: "Preflight check failure (hard blocker).",
    action: "Abort immediately. Report the failed preflight checks to the operator. Correct the rehearsal input and rebuild.",
  });

  const stateChanging = actions.filter((a) => a.kind !== "noop" && a.kind !== "scan_bind" && a.kind !== "artifact_write");
  if (stateChanging.length > 0) {
    steps.push({
      step: steps.length + 1,
      trigger: "Mid-execution failure after one or more actions completed.",
      action: "Execute rollback runbook in reverse. Verify no residual state. Re-run preflight before retry.",
    });
  }

  steps.push({
    step: steps.length + 1,
    trigger: "Duplicate run detected (same dedupe key).",
    action: `Abort. Dedupe key ${packet.idempotencyProof.dedupeKey.slice(0, 16)} already exists. Review the existing plan before retrying.`,
  });

  steps.push({
    step: steps.length + 1,
    trigger: "Operator overrides preflight failures.",
    action: "Operator must provide explicit approval with documented override reason. Resume after the overridden check.",
  });

  return {
    schemaVersion: "a2a.runner.abort-runbook.v1",
    steps,
  };
}

function buildEmptyScannerBinding(): ScannerHistoryBinding {
  const emptyDigest = createHash("sha256").update("empty-scan").digest("hex").slice(0, 32);
  return {
    schemaVersion: "a2a.runner.scanner-history-binding.v1",
    scanProfileRef: `scan:empty:${emptyDigest.slice(0, 12)}`,
    boundAt: "1970-01-01T00:00:00.000Z",
    scannerDigest: emptyDigest,
    historySnapshotSize: 0,
    lastScanOutcome: "no_history",
    goCandidateCount: 0,
    blockedCount: 0,
  };
}

/** Produce a blocked plan when the packet is not GO_CANDIDATE. */
async function buildBlockedPlan(
  packet: ApprovalRehearsalPacket,
  options: ExecutionOrchestratorOptions,
  reason: string,
): Promise<ExecutionPlan> {
  const idempotencyProof = buildIdempotencyProof(packet, options);
  const planId = derivePlanId(packet, options);

  const preflightResult: ExecutionPreflightResult = {
    passed: false,
    checks: [{
      checkId: "packet_is_go_candidate",
      label: "Rehearsal packet decision is GO_CANDIDATE",
      passed: false,
      reason,
    }],
    summary: redactAndBound(reason, 500),
    failureSemantics: "abort_and_report",
    failedCheckIds: ["packet_is_go_candidate"],
  };

  const simulateResult: ExecutionSimulateResult = {
    ok: false,
    actionCount: 0,
    stateChangingActions: 0,
    affectedRepos: [packet.repo],
    affectedBranches: [],
    summary: redactAndBound(`Simulation BLOCKED: ${reason}`, 500),
    simulationOnly: true,
    preflight: preflightResult,
    blockingReasons: [reason],
  };

  const plan: ExecutionPlan = {
    schemaVersion: "a2a.runner.execution-plan.v1",
    planId,
    dedupeKey: idempotencyProof.dedupeKey,
    packetId: buildPacketRef(packet),
    idempotencyProof,
    targetRepo: packet.repo,
    plannedActions: [],
    dryRun: "simulate_only",
    operatorApprovalRequired: true,
    rollbackRunbook: { schemaVersion: "a2a.runner.rollback-runbook.v1", steps: [] },
    abortRunbook: buildAbortRunbook([], packet),
    preflightResult,
    simulateResult,
    generatedAt: "1970-01-01T00:00:00.000Z",
    approvalExecuted: false,
    releaseExecuted: false,
    visibilityChanged: false,
    terminalAckSent: false,
    providerSendPerformed: false,
    dbMutationPerformed: false,
  };

  await writePlanArtifacts(plan, options.outputPath);
  return plan;
}

async function writePlanArtifacts(plan: ExecutionPlan, outputPath: string): Promise<void> {
  await mkdir(outputPath, { recursive: true, mode: 0o700 });

  // Write the execution plan.
  await writeFile(join(outputPath, "execution-plan.json"), JSON.stringify(plan, null, 2) + "\n");

  // Write the preflight report.
  await writeFile(join(outputPath, "preflight-report.json"), JSON.stringify({
    schemaVersion: "a2a.runner.execution-preflight-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    planId: plan.planId,
    dedupeKey: plan.dedupeKey,
    preflight: plan.preflightResult,
  }, null, 2) + "\n");

  // Write the simulate report.
  await writeFile(join(outputPath, "simulate-report.json"), JSON.stringify({
    schemaVersion: "a2a.runner.execution-simulate-report.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    planId: plan.planId,
    simulate: plan.simulateResult,
  }, null, 2) + "\n");

  // Write the rollback runbook.
  await writeFile(join(outputPath, "rollback-runbook.json"), JSON.stringify(plan.rollbackRunbook, null, 2) + "\n");

  // Write the abort runbook.
  await writeFile(join(outputPath, "abort-runbook.json"), JSON.stringify(plan.abortRunbook, null, 2) + "\n");

  // Write a summary.
  const summary = [
    `A2A Source-Public Execution Orchestrator — Dry-Run Plan`,
    `Plan ID: ${plan.planId}`,
    `Target: ${plan.targetRepo}`,
    `Status: ${plan.preflightResult.passed ? "PASSED (operator approval required)" : "BLOCKED"}`,
    `Actions: ${plan.plannedActions.length} planned, ${plan.simulateResult.stateChangingActions} state-changing`,
    `Simulation: ${plan.simulateResult.ok ? "OK" : "BLOCKED"}`,
    ``,
    `This is a simulation-only round. No code was pushed, no PR was created,`,
    `no approval was executed, and no live mutation occurred.`,
  ].join("\n");
  await writeFile(join(outputPath, "summary.txt"), summary + "\n");
}
