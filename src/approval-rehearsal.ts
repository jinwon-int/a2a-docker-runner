import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalRehearsalDecision,
  ApprovalRehearsalIdempotencyProof,
  ApprovalRehearsalPacket,
  ApprovalRehearsalSafetyGate,
  ArtifactEvidencePart,
  ArtifactManifest,
  ArtifactManifestEntry,
} from "./types.js";

/**
 * Source-Public Approval Rehearsal
 *
 * Produces a deterministic, replay-safe approval rehearsal packet BEFORE any
 * real source-public execution.  The rehearsal output includes:
 *
 *  - Deterministic approval packet (GO_CANDIDATE / NO_GO / NEEDS_OPERATOR_APPROVAL)
 *  - Integrated evidence bundle (ArtifactManifest v1)
 *  - Idempotency proof (dedupe key + input fingerprint)
 *  - Rollback/abort paths documented for operator reference
 *  - No-live Terminal Brief rehearsal (never ACK, never send)
 *
 * Safety gates are checked first.  Any failing gate immediately moves the
 * decision from GO_CANDIDATE to NO_GO or NEEDS_OPERATOR_APPROVAL.
 *
 * Parent: a2a-docker-runner#185
 * Parent: a2a-plane#211
 */

// ─── Safety gate definitions ────────────────────────────────────────────────

/** Safety gates that are always checked during a source-public approval rehearsal. */
const DEFAULT_SAFETY_GATES: Omit<ApprovalRehearsalSafetyGate, "passed" | "reason">[] = [
  {
    id: "no_production_deploy",
    label: "No production deploy, restart, or live service mutation",
  },
  {
    id: "no_gateway_broker_worker_restart",
    label: "No Gateway, broker, or worker restart",
  },
  {
    id: "no_live_provider_send",
    label: "No live provider send (Telegram, Signal, etc.)",
  },
  {
    id: "no_terminal_ack",
    label: "No terminal ACK or read-receipt claim",
  },
  {
    id: "no_production_db_mutation",
    label: "No production database mutation",
  },
  {
    id: "no_secret_or_visibility_change",
    label: "No secret disclosure or repository visibility change",
  },
  {
    id: "no_history_rewrite",
    label: "No repository history rewrite or force-push",
  },
  {
    id: "no_release_publication",
    label: "No release publication, community post, or npm publish",
  },
  {
    id: "no_automatic_merge_approval",
    label: "No automatic merge or approval without explicit operator approval",
  },
  {
    id: "no_approval_execution",
    label: "No approval execution — rehearsal round only",
  },
  {
    id: "rehearsal_round_only",
    label: "This round produces approval packets only, never executes",
  },
];

// ─── Public options ─────────────────────────────────────────────────────────

export interface ApprovalRehearsalOptions {
  /** Safe run identifier from the task payload. */
  runId: string;
  /** Optional safe trace identifier. */
  traceId?: string;
  /** Target repository (owner/repo). */
  repo: string;
  /** Target branch. */
  branch?: string;
  /** Short operator-facing description of the proposed change. */
  proposedChange: string;
  /** Output directory for the evidence bundle. Will be created if missing. */
  outputPath: string;
  /** Replay index for deduplication; 0 for the first rehearsal. */
  replayIndex?: number;
  /** Additional safety gates beyond the defaults. */
  extraSafetyGates?: Omit<ApprovalRehearsalSafetyGate, "passed" | "reason">[];
  /** Pre-computed safety gate results from an operator review pass. */
  operatorGateResults?: Partial<Record<string, { passed: boolean; reason?: string }>>;
  /** Issue URL for evidence hints when a linked GitHub issue exists. */
  issueUrl?: string;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Run a source-public approval rehearsal.
 *
 * Produces:
 *  - A deterministic `ApprovalRehearsalPacket`
 *  - An integrated evidence bundle written to `outputPath`
 *
 * No live operations are performed.  This function is pure evidence production.
 */
export async function runApprovalRehearsal(
  options: ApprovalRehearsalOptions,
): Promise<ApprovalRehearsalPacket> {
  // 1. Build the dedupe key and input fingerprint.
  const idempotencyProof = buildIdempotencyProof(options);

  // 2. Evaluate all safety gates.
  const allGateDefs = [...DEFAULT_SAFETY_GATES, ...(options.extraSafetyGates ?? [])];
  const safetyGates: ApprovalRehearsalSafetyGate[] = allGateDefs.map((def) => {
    const opResult = options.operatorGateResults?.[def.id];
    if (opResult) {
      return { ...def, ...opResult };
    }
    // Default: all gates pass in rehearsal mode because no execution happens.
    return { ...def, passed: true };
  });

  // 3. Compute decision.
  const { decision, decisionReason } = computeDecision(safetyGates, options);

  // 4. Build abort and rollback paths (always present, even for GO_CANDIDATE).
  const abortPaths = buildAbortPaths(options, decision);
  const rollbackPaths = buildRollbackPaths(options, decision);

  // 5. Write the integrated evidence bundle to disk.
  const evidenceBundlePath = "manifest.json";
  await writeEvidenceBundle(options, outputPathFrom(options), safetyGates, idempotencyProof, decision, decisionReason);

  // 6. Build and return the approval packet.
  const packet: ApprovalRehearsalPacket = {
    schemaVersion: "a2a.runner.approval-rehearsal.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    runId: options.runId,
    ...(options.traceId ? { traceId: options.traceId } : {}),
    repo: options.repo,
    ...(options.branch ? { branch: options.branch } : {}),
    proposedChange: options.proposedChange,
    safetyGates,
    idempotencyProof,
    decision,
    decisionReason,
    abortPaths,
    rollbackPaths,
    evidenceBundlePath,
    ...(options.issueUrl ? {
      evidenceHints: {
        schemaVersion: "a2a.runner.evidence-hints.v1" as const,
        issueUrl: options.issueUrl,
      },
    } : {}),
  };

  // Write the packet alongside the manifest.
  await writeFile(join(options.outputPath, "approval-rehearsal-packet.json"), JSON.stringify(packet, null, 2) + "\n");

  return packet;
}

// ─── Decision engine ────────────────────────────────────────────────────────

function computeDecision(
  gates: ApprovalRehearsalSafetyGate[],
  _options: ApprovalRehearsalOptions,
): { decision: ApprovalRehearsalDecision; decisionReason: string } {
  const failedGates = gates.filter((g) => !g.passed);

  if (failedGates.length === 0) {
    return {
      decision: "GO_CANDIDATE",
      decisionReason: "All safety gates passed. Rehearsal packet produced. Operator must explicitly approve before executing any source-public change.",
    };
  }

  // Classify failures: operator-approvable vs hard blockers.
  const hardBlockers = failedGates.filter((g) =>
    g.id === "no_approval_execution" ||
    g.id === "rehearsal_round_only" ||
    g.id === "no_secret_or_visibility_change" ||
    g.id === "no_history_rewrite" ||
    g.id === "no_live_provider_send",
  );

  if (hardBlockers.length > 0) {
    const reasons = hardBlockers.map((g) => `${g.id}: ${g.reason ?? "hard block"}`).join("; ");
    return {
      decision: "NO_GO",
      decisionReason: `Hard-blocker safety gate(s) failed: ${reasons}`,
    };
  }

  // Remaining failures may be resolvable with operator approval.
  const opReasons = failedGates.map((g) => `${g.id}: ${g.reason ?? "requires operator review"}`).join("; ");
  return {
    decision: "NEEDS_OPERATOR_APPROVAL",
    decisionReason: `One or more safety gates require operator review: ${opReasons}`,
  };
}

// ─── Idempotency proof ──────────────────────────────────────────────────────

function buildIdempotencyProof(options: ApprovalRehearsalOptions): ApprovalRehearsalIdempotencyProof {
  const replayIndex = options.replayIndex ?? 0;

  // Deterministic dedupe key: stable across replays for the same logical rehearsal.
  const dedupeKey = buildDedupeKey(options);

  // Deterministic input fingerprint using SHA-256 of sorted, secret-free fields.
  const fingerprintSource = JSON.stringify({
    runId: options.runId,
    traceId: options.traceId ?? "",
    repo: options.repo,
    branch: options.branch ?? "",
    proposedChange: options.proposedChange,
  });
  const inputFingerprint = createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 32);

  return {
    dedupeKey,
    inputFingerprint,
    wasExecuted: false,
    replayIndex,
  };
}

function buildDedupeKey(options: ApprovalRehearsalOptions): string {
  const runPart = (options.runId).slice(0, 64);
  const tracePart = (options.traceId ?? "").slice(0, 40);
  const changePart = options.proposedChange.slice(0, 60).replace(/[^A-Za-z0-9_.-]/g, "_");
  const parts = [runPart, tracePart, changePart].filter(Boolean);
  // Hash the concatenation to keep the key compact and deterministic.
  const raw = parts.join("|");
  return `a2a-src-pub-rehearsal:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

// ─── Abort and rollback paths ───────────────────────────────────────────────

function buildAbortPaths(options: ApprovalRehearsalOptions, decision: ApprovalRehearsalDecision): string[] {
  const paths: string[] = [
    "Abort: delete the approval rehearsal packet and evidence bundle from the output directory.",
    "Abort: discard this branch — no code or config changes have been deployed.",
  ];

  if (decision === "GO_CANDIDATE") {
    paths.push(
      "Abort: operator may decide not to approve the candidate. No state has been mutated.",
      "Abort: the rehearsal packet is advisory; discard and re-run with corrected inputs.",
    );
  }

  if (decision === "NO_GO") {
    paths.push(
      "Abort: review hard-blocker reasons, correct the safety gate failures, and re-run the rehearsal.",
    );
  }

  if (decision === "NEEDS_OPERATOR_APPROVAL") {
    paths.push(
      "Abort: operator may decide the gate failures are not resolvable at this time.",
      "Abort: retry after operator resolves the gates that require review.",
    );
  }

  return paths;
}

function buildRollbackPaths(options: ApprovalRehearsalOptions, decision: ApprovalRehearsalDecision): string[] {
  const paths: string[] = [
    "Rollback: no state was mutated during this rehearsal round — nothing to roll back.",
    "Rollback: the evidence bundle is self-contained under the output directory; remove the directory to clean up.",
  ];

  if (decision === "GO_CANDIDATE") {
    paths.push(
      "Rollback: before approval execution, verify the packet decision and evidence bundle are consistent.",
    );
  }

  if (decision !== "GO_CANDIDATE") {
    paths.push(
      "Rollback: re-run the rehearsal with corrected safety gates to produce a new GO_CANDIDATE packet.",
    );
  }

  return paths;
}

// ─── Evidence bundle ────────────────────────────────────────────────────────

function outputPathFrom(options: ApprovalRehearsalOptions): string {
  return options.outputPath;
}

async function writeEvidenceBundle(
  options: ApprovalRehearsalOptions,
  outputPath: string,
  safetyGates: ApprovalRehearsalSafetyGate[],
  idempotencyProof: ApprovalRehearsalIdempotencyProof,
  decision: ApprovalRehearsalDecision,
  decisionReason: string,
): Promise<void> {
  await mkdir(outputPath, { recursive: true, mode: 0o700 });

  const summary = buildRehearsalSummary(decision, decisionReason, safetyGates);

  // Write the summary as a standalone artifact.
  await writeFile(join(outputPath, "summary.txt"), summary.trim() + "\n");

  // Build evidence parts.
  const evidenceParts: ArtifactEvidencePart[] = [
    {
      kind: "log",
      label: "summary.txt",
      status: decision === "GO_CANDIDATE" ? "passed" : decision === "NO_GO" ? "failed" : "blocked",
      path: "summary.txt",
      excerpt: summary.slice(0, 500),
    },
    {
      kind: "log",
      label: "safety-gates.json",
      status: safetyGates.every((g) => g.passed) ? "passed" : "failed",
      path: "safety-gates.json",
      excerpt: `${safetyGates.filter((g) => g.passed).length}/${safetyGates.length} gates passed`,
    },
    {
      kind: "file",
      label: "approval-rehearsal-packet.json",
      status: "passed",
      path: "approval-rehearsal-packet.json",
      excerpt: `${decision}: ${decisionReason.slice(0, 200)}`,
    },
  ];

  // Write safety gates as a separate artifact for evidence chain transparency.
  await writeFile(join(outputPath, "safety-gates.json"), JSON.stringify({
    schemaVersion: "a2a.runner.approval-rehearsal-safety-gates.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    gates: safetyGates,
    idempotencyProof,
    decision,
  }, null, 2) + "\n");

  // Build the artifact manifest.
  const artifacts: ArtifactManifestEntry[] = [
    { path: "summary.txt", name: "summary.txt", sizeBytes: summary.trim().length + 1 },
    { path: "safety-gates.json", name: "safety-gates.json", sizeBytes: 0 }, // placeholder; actual size written by fs
    { path: "approval-rehearsal-packet.json", name: "approval-rehearsal-packet.json", sizeBytes: 0 },
  ];

  const manifest: ArtifactManifest = {
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    taskId: options.runId,
    repo: options.repo,
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.issueUrl ? { issueUrl: options.issueUrl } : {}),
    status: decision === "GO_CANDIDATE" ? "done" : "blocked",
    summary,
    evidence: evidenceParts,
    artifacts,
    ...(options.issueUrl ? {
      evidenceHints: {
        schemaVersion: "a2a.runner.evidence-hints.v1" as const,
        issueUrl: options.issueUrl,
      },
    } : {}),
  };

  await writeFile(join(outputPath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function buildRehearsalSummary(
  decision: ApprovalRehearsalDecision,
  decisionReason: string,
  safetyGates: ApprovalRehearsalSafetyGate[],
): string {
  const passed = safetyGates.filter((g) => g.passed).length;
  const total = safetyGates.length;

  let summary = `Source-Public Approval Rehearsal: ${decision}\n`;
  summary += `Safety gates: ${passed}/${total} passed\n`;
  summary += `Decision reason: ${decisionReason}\n`;
  summary += `This is a rehearsal round. No approval, release, visibility change,`;
  summary += ` live provider send, deploy, restart, terminal ACK, or DB mutation was performed.\n`;

  if (decision === "GO_CANDIDATE") {
    summary += `\nNext step: operator must explicitly approve the GO_CANDIDATE`;
    summary += ` packet before any source-public execution.\n`;
  } else if (decision === "NO_GO") {
    summary += `\nNext step: review failed safety gates, correct the blockers,`;
    summary += ` and re-run the rehearsal.\n`;
  } else {
    summary += `\nNext step: operator must review the flagged gates`;
    summary += ` and explicitly approve before proceeding.\n`;
  }

  return summary;
}
