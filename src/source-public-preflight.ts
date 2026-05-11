import { createHash } from "node:crypto";
import type {
  ArtifactManifest,
  SourcePublicApprovalPacket,
  SourcePublicExecutionPlanAction,
  SourcePublicExecutionPreflight,
  SourcePublicExecutionPreflightMode,
  SourcePublicExecutionPreflightStatus,
} from "./types.js";
import type { ScanProfile } from "./scanner.js";

/**
 * Build a deterministic, no-live source-public final execution preflight capsule.
 *
 * The capsule is intentionally an operator-gated plan, not execution.  It binds
 * the approval packet to a redacted artifact manifest digest and a scanner
 * history digest, then fails closed when packet/scanner/history inputs are
 * missing or mismatched.
 */
export interface SourcePublicExecutionPreflightInput {
  approvedPacket: SourcePublicApprovalPacket;
  manifest?: ArtifactManifest;
  scanProfile?: ScanProfile;
  mode?: SourcePublicExecutionPreflightMode;
  runId?: string;
  replayIndex?: number;
  /** Optional digest from the approved evidence packet; mismatch blocks preflight. */
  expectedManifestDigest?: string;
}

export function buildSourcePublicExecutionPreflight(
  input: SourcePublicExecutionPreflightInput,
): SourcePublicExecutionPreflight {
  const mode = input.mode ?? "dry_run";
  if (!isPreflightMode(mode)) throw new Error("source-public preflight mode must be dry_run or simulate");
  const packet = sanitizeApprovedPacket(input.approvedPacket);
  if (!packet) throw new Error("invalid source-public approval packet");
  const rollbackPath = safeText(input.approvedPacket.rollbackPath, 160) ?? "rollback/source-public-approval-rehearsal.md";
  const abortPath = safeText(input.approvedPacket.abortPath, 160) ?? "abort/source-public-approval-rehearsal.md";

  const manifestDigest = digestStableJson(input.manifest ?? { missing: "artifact-manifest" });
  const historyDigest = digestStableJson(input.scanProfile ?? { missing: "scan-profile" });
  const replayIndex = safeReplayIndex(input.replayIndex);
  const expectedManifestDigest = safeDigest(input.expectedManifestDigest);

  const approvalPacketNotGoCandidate = packet.decision !== "GO_CANDIDATE";
  const missingScannerHistory = !input.scanProfile;
  const manifestMismatch = Boolean(expectedManifestDigest && expectedManifestDigest !== manifestDigest);
  const reasons = buildPreflightFailureReasons({
    approvalPacketNotGoCandidate,
    missingManifest: !input.manifest,
    missingScannerHistory,
    manifestMismatch,
  });
  const status: SourcePublicExecutionPreflightStatus = reasons.length === 0
    ? "ready_for_operator_approval"
    : "blocked";
  const planSeed = {
    packetId: packet.packetId,
    targetRepo: packet.targetRepo,
    dedupeKey: packet.dedupeKey,
    manifestDigest,
    historyDigest,
    mode,
  };
  const inputFingerprint = digestStableJson(planSeed);
  const planId = `source-public-plan-${inputFingerprint.slice(0, 16)}`;
  const planDedupeKey = `source-public-execution:${packet.dedupeKey}:${inputFingerprint.slice(0, 16)}`;

  const preflight: SourcePublicExecutionPreflight = {
    schemaVersion: "a2a.runner.source-public-execution-preflight.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(safeText(input.runId, 160) ? { runId: safeText(input.runId, 160)! } : {}),
    mode,
    status,
    approvedPacket: packet,
    scannerHistoryBinding: {
      scanProfileSchemaVersion: "a2a.runner.scan-profile.v1",
      scannerBound: true,
      historyRunCount: input.scanProfile?.runs.length ?? 0,
      evidenceBundlePath: "artifacts/manifest.json",
      manifestDigest,
      historyDigest,
    },
    executionPlan: {
      planId,
      planDedupeKey,
      operatorGate: "explicit_operator_approval_required",
      dryRunOnly: true,
      simulateOnly: mode === "simulate",
      liveExecutionBlocked: true,
      approvalExecutionBlocked: true,
      replayProtected: true,
      actions: buildExecutionPlanActions(packet),
    },
    replayProtection: {
      idempotencyKey: planDedupeKey,
      inputFingerprint,
      replayIndex,
      duplicateDetected: replayIndex > 0,
    },
    rollbackAbortRunbook: {
      rollbackSteps: [
        "Rollback: no source-public side effects were performed by this preflight capsule.",
        "Rollback: re-bind scanner/history evidence and regenerate a new preflight capsule before any approved execution retry.",
        `Rollback: use packet rollback runbook ${rollbackPath} if a later explicitly approved execution mutates state.`,
      ],
      abortSteps: [
        "Abort: stop before operator approval; do not execute approval, release, visibility, provider, deploy, DB, or ACK actions.",
        "Abort: mark the preflight blocked if scanner/history evidence is missing, stale, or mismatched.",
        `Abort: use packet abort runbook ${abortPath} and discard plan ${planId}.`,
      ],
    },
    preflightFailureSemantics: {
      failClosed: true,
      reasons,
      approvalPacketNotGoCandidate,
      missingScannerHistory,
      manifestMismatch,
    },
    safetyGates: safeExecutionSafetyGates(),
  };

  const sanitized = sanitizeSourcePublicExecutionPreflight(preflight);
  if (!sanitized) throw new Error("failed to build safe source-public execution preflight");
  return sanitized;
}

export function digestStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function sanitizeSourcePublicExecutionPreflight(input: unknown): SourcePublicExecutionPreflight | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== "a2a.runner.source-public-execution-preflight.v1") return undefined;
  if (value.generatedAt !== "1970-01-01T00:00:00.000Z") return undefined;
  if (!isPreflightMode(value.mode)) return undefined;
  if (!isPreflightStatus(value.status)) return undefined;
  const packet = sanitizeApprovedPacket(value.approvedPacket);
  const binding = sanitizeScannerHistoryBinding(value.scannerHistoryBinding);
  const plan = sanitizeExecutionPlan(value.executionPlan, packet?.targetRepo);
  const replay = sanitizeReplayProtection(value.replayProtection);
  const runbook = sanitizeRunbook(value.rollbackAbortRunbook);
  const semantics = sanitizeFailureSemantics(value.preflightFailureSemantics);
  if (!packet || !binding || !plan || !replay || !runbook || !semantics) return undefined;
  if (!hasSafeExecutionGates(value.safetyGates)) return undefined;
  if (value.status === "ready_for_operator_approval" && semantics.reasons.length > 0) return undefined;
  return {
    schemaVersion: "a2a.runner.source-public-execution-preflight.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    ...(safeText(typeof value.runId === "string" ? value.runId : undefined, 160) ? { runId: safeText(value.runId as string, 160)! } : {}),
    mode: value.mode,
    status: value.status,
    approvedPacket: packet,
    scannerHistoryBinding: binding,
    executionPlan: plan,
    replayProtection: replay,
    rollbackAbortRunbook: runbook,
    preflightFailureSemantics: semantics,
    safetyGates: safeExecutionSafetyGates(),
  };
}

function buildPreflightFailureReasons(flags: {
  approvalPacketNotGoCandidate: boolean;
  missingManifest: boolean;
  missingScannerHistory: boolean;
  manifestMismatch: boolean;
}): string[] {
  const reasons: string[] = [];
  if (flags.approvalPacketNotGoCandidate) reasons.push("approval packet decision is not GO_CANDIDATE");
  if (flags.missingManifest) reasons.push("artifact manifest evidence is missing");
  if (flags.missingScannerHistory) reasons.push("scanner/history evidence is missing");
  if (flags.manifestMismatch) reasons.push("approved manifest digest does not match execution preflight manifest digest");
  return reasons;
}

function buildExecutionPlanActions(packet: SourcePublicExecutionPreflight["approvedPacket"]): SourcePublicExecutionPlanAction[] {
  return [
    {
      sequence: 1,
      id: "bind-approved-evidence",
      label: "Bind approved packet to artifact manifest and scanner/history digests",
      targetRepo: packet.targetRepo,
      requiresExplicitOperatorApproval: true,
      dryRunOnly: true,
      sideEffectPerformed: false,
    },
    {
      sequence: 2,
      id: "operator-approval-gate",
      label: "Pause for explicit operator approval before any source-public side effect",
      targetRepo: packet.targetRepo,
      requiresExplicitOperatorApproval: true,
      dryRunOnly: true,
      sideEffectPerformed: false,
    },
    {
      sequence: 3,
      id: "simulate-source-public-execution",
      label: "Simulate exact final source-public execution plan without mutating state",
      targetRepo: packet.targetRepo,
      requiresExplicitOperatorApproval: true,
      dryRunOnly: true,
      sideEffectPerformed: false,
    },
    {
      sequence: 4,
      id: "record-rollback-abort-runbook",
      label: "Record rollback and abort runbook references for operator review",
      targetRepo: packet.targetRepo,
      requiresExplicitOperatorApproval: true,
      dryRunOnly: true,
      sideEffectPerformed: false,
    },
  ];
}

function sanitizeApprovedPacket(input: unknown): SourcePublicExecutionPreflight["approvedPacket"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Partial<SourcePublicApprovalPacket>;
  if (value.schemaVersion !== "a2a.runner.source-public-approval-packet.v1") return undefined;
  if (value.evidenceBundlePath !== "artifacts/manifest.json") return undefined;
  if ("operatorApprovalRequired" in value && value.operatorApprovalRequired !== true) return undefined;
  if ("approvalExecuted" in value && value.approvalExecuted !== false) return undefined;
  if ("releaseExecuted" in value && value.releaseExecuted !== false) return undefined;
  if ("visibilityChanged" in value && value.visibilityChanged !== false) return undefined;
  if ("terminalAckSent" in value && value.terminalAckSent !== false) return undefined;
  if ("providerSendPerformed" in value && value.providerSendPerformed !== false) return undefined;
  if ("dbMutationPerformed" in value && value.dbMutationPerformed !== false) return undefined;
  if (!isSourcePublicDecision(value.decision)) return undefined;
  const packetId = safeText(value.packetId, 120);
  const targetRepo = safeRepo(value.targetRepo);
  const dedupeKey = safeText(value.dedupeKey, 240);
  if (!packetId || !targetRepo || !dedupeKey) return undefined;
  return {
    schemaVersion: "a2a.runner.source-public-approval-packet.v1",
    packetId,
    targetRepo,
    decision: value.decision,
    dedupeKey,
    evidenceBundlePath: "artifacts/manifest.json",
  };
}

function sanitizeScannerHistoryBinding(input: unknown): SourcePublicExecutionPreflight["scannerHistoryBinding"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as SourcePublicExecutionPreflight["scannerHistoryBinding"];
  if (value.scanProfileSchemaVersion !== "a2a.runner.scan-profile.v1") return undefined;
  if (value.scannerBound !== true || value.evidenceBundlePath !== "artifacts/manifest.json") return undefined;
  if (!Number.isInteger(value.historyRunCount) || value.historyRunCount < 0) return undefined;
  const manifestDigest = safeDigest(value.manifestDigest);
  const historyDigest = safeDigest(value.historyDigest);
  if (!manifestDigest || !historyDigest) return undefined;
  return {
    scanProfileSchemaVersion: "a2a.runner.scan-profile.v1",
    scannerBound: true,
    historyRunCount: value.historyRunCount,
    evidenceBundlePath: "artifacts/manifest.json",
    manifestDigest,
    historyDigest,
  };
}

function sanitizeExecutionPlan(input: unknown, targetRepo: string | undefined): SourcePublicExecutionPreflight["executionPlan"] | undefined {
  if (!targetRepo || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as SourcePublicExecutionPreflight["executionPlan"];
  if (value.operatorGate !== "explicit_operator_approval_required") return undefined;
  if (value.dryRunOnly !== true || value.liveExecutionBlocked !== true || value.approvalExecutionBlocked !== true || value.replayProtected !== true) return undefined;
  if (typeof value.simulateOnly !== "boolean") return undefined;
  const planId = safeText(value.planId, 120);
  const planDedupeKey = safeText(value.planDedupeKey, 300);
  const actions = Array.isArray(value.actions) ? value.actions.map((action) => sanitizeAction(action, targetRepo)).filter((action): action is SourcePublicExecutionPlanAction => Boolean(action)) : [];
  if (!planId || !planDedupeKey || actions.length === 0 || actions.length > 12 || actions.length !== value.actions?.length) return undefined;
  actions.sort((a, b) => a.sequence - b.sequence);
  return {
    planId,
    planDedupeKey,
    operatorGate: "explicit_operator_approval_required",
    dryRunOnly: true,
    simulateOnly: value.simulateOnly,
    liveExecutionBlocked: true,
    approvalExecutionBlocked: true,
    replayProtected: true,
    actions,
  };
}

function sanitizeAction(input: unknown, targetRepo: string): SourcePublicExecutionPlanAction | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as SourcePublicExecutionPlanAction;
  if (!Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > 99) return undefined;
  if (value.targetRepo !== targetRepo) return undefined;
  if (value.requiresExplicitOperatorApproval !== true || value.dryRunOnly !== true || value.sideEffectPerformed !== false) return undefined;
  const id = safeText(value.id, 80);
  const label = safeText(value.label, 180);
  if (!id || !label) return undefined;
  return { sequence: value.sequence, id, label, targetRepo, requiresExplicitOperatorApproval: true, dryRunOnly: true, sideEffectPerformed: false };
}

function sanitizeReplayProtection(input: unknown): SourcePublicExecutionPreflight["replayProtection"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as SourcePublicExecutionPreflight["replayProtection"];
  const idempotencyKey = safeText(value.idempotencyKey, 300);
  const inputFingerprint = safeDigest(value.inputFingerprint);
  if (!idempotencyKey || !inputFingerprint) return undefined;
  if (!Number.isInteger(value.replayIndex) || value.replayIndex < 0) return undefined;
  if (typeof value.duplicateDetected !== "boolean") return undefined;
  if ((value.replayIndex > 0) !== value.duplicateDetected) return undefined;
  return { idempotencyKey, inputFingerprint, replayIndex: value.replayIndex, duplicateDetected: value.duplicateDetected };
}

function sanitizeRunbook(input: unknown): SourcePublicExecutionPreflight["rollbackAbortRunbook"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as SourcePublicExecutionPreflight["rollbackAbortRunbook"];
  const rollbackSteps = sanitizeStepList(value.rollbackSteps);
  const abortSteps = sanitizeStepList(value.abortSteps);
  if (rollbackSteps.length === 0 || abortSteps.length === 0) return undefined;
  return { rollbackSteps, abortSteps };
}

function sanitizeFailureSemantics(input: unknown): SourcePublicExecutionPreflight["preflightFailureSemantics"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as SourcePublicExecutionPreflight["preflightFailureSemantics"];
  if (value.failClosed !== true) return undefined;
  if (typeof value.approvalPacketNotGoCandidate !== "boolean" || typeof value.missingScannerHistory !== "boolean" || typeof value.manifestMismatch !== "boolean") return undefined;
  const reasons = sanitizeStepList(value.reasons, 10, 220);
  return {
    failClosed: true,
    reasons,
    approvalPacketNotGoCandidate: value.approvalPacketNotGoCandidate,
    missingScannerHistory: value.missingScannerHistory,
    manifestMismatch: value.manifestMismatch,
  };
}

function sanitizeStepList(input: unknown, maxItems = 8, maxLen = 240): string[] {
  if (!Array.isArray(input) || input.length > maxItems) return [];
  return input.map((step) => safeText(typeof step === "string" ? step : undefined, maxLen)).filter((step): step is string => Boolean(step));
}

function hasSafeExecutionGates(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as SourcePublicExecutionPreflight["safetyGates"];
  return value.operatorApprovalRequired === true
    && value.sourcePublicExecutionBlocked === true
    && value.approvalExecuted === false
    && value.releaseExecuted === false
    && value.visibilityChanged === false
    && value.liveProviderSendPerformed === false
    && value.terminalAckSent === false
    && value.dbMutationPerformed === false
    && value.deployOrRestartPerformed === false;
}

function safeExecutionSafetyGates(): SourcePublicExecutionPreflight["safetyGates"] {
  return {
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function safeReplayIndex(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function isPreflightMode(value: unknown): value is SourcePublicExecutionPreflightMode {
  return value === "dry_run" || value === "simulate";
}

function isPreflightStatus(value: unknown): value is SourcePublicExecutionPreflightStatus {
  return value === "ready_for_operator_approval" || value === "blocked";
}

function isSourcePublicDecision(value: unknown): value is SourcePublicApprovalPacket["decision"] {
  return value === "GO_CANDIDATE" || value === "NO_GO" || value === "NEEDS_OPERATOR_APPROVAL";
}

function safeRepo(value: unknown): string | undefined {
  const safe = safeText(typeof value === "string" ? value : undefined, 160);
  return safe && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(safe) ? safe : undefined;
}

function safeDigest(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function safeText(value: string | undefined, maxLen: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\0/g, "").replace(/[\r\n]+/g, " ").trim();
  if (!cleaned || hasUnsafeContent(cleaned)) return undefined;
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 12).trimEnd()}...truncated`;
}

function hasUnsafeContent(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Authorization:\s*(?:Bearer|token)|\/root\/|\/home\/|\/tmp\/|\/var\/folders\/|token=|password=|secret=|api[_-]?key=)/i.test(value);
}
