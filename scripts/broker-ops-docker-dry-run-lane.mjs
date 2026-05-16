#!/usr/bin/env node
/**
 * broker-ops-docker-dry-run-lane — R27 Team1/nosuk
 *
 * Bounded script/runbook harness for Terminal Brief canary dry-run execution.
 *
 * The lane validates deterministic evidence for:
 *   evidence dir, safe cursor read, operatorEvents restore trap,
 *   one fresh analysis-only task plan, receipt/ACK evidence fields,
 *   and compact summary.
 *
 * It NEVER performs:
 *   - live provider send            (noLiveProviderSend: true)
 *   - Gateway restart                (gatewayRestartPerformed: false)
 *   - DB mutation                    (dbMutationPerformed: false)
 *   - manual ACK/replay              (manualAckReplayPerformed: false)
 *   - historical replay              (historicalReplayPerformed: false)
 *   - operatorEvents restore         (restorePerformed: false)
 *   - Terminal Brief ACK             (terminalAckPerformed: false)
 *
 * Safety gates fail closed.
 *
 * Parent: a2a-plane#364
 * Lane: a2a-docker-runner#280
 *
 * Usage:
 *   node scripts/broker-ops-docker-dry-run-lane.mjs \
 *     --fixture examples/broker-ops-docker-dry-run-canonical.json
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ── Schema versions ─────────────────────────────────────────────────────

const SCHEMA = {
  CURSOR_READ: "a2a.runner.dry-run-cursor-read.v1",
  RESTORE_TRAP: "a2a.runner.operator-events-restore-trap.v1",
  RECEIPT_EVIDENCE: "a2a.runner.dry-run-receipt-evidence.v1",
  ANALYSIS_PLAN: "a2a.runner.dry-run-analysis-task-plan.v1",
  COMPACT_SUMMARY: "a2a.runner.dry-run-compact-summary.v1",
  LANE_EVIDENCE: "a2a.runner.broker-ops-docker-dry-run-lane.v1",
};

// ── Helpers ─────────────────────────────────────────────────────────────

const BANNED_SUBSTRINGS = [
  "x-access-token",
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  ".openclaw",
  "MEMORY.md",
  "memory/",
  "/home/",
  "/root/",
  "/private/",
];

function checkForbidden(value, context) {
  if (typeof value !== "string") return value;
  for (const banned of BANNED_SUBSTRINGS) {
    if (value.includes(banned)) {
      throw new Error(
        `${context} leaked forbidden value: ${banned}`,
      );
    }
  }
  return value;
}

function safeText(value, maxLen = 180) {
  if (typeof value !== "string" || !value.trim()) return "";
  const clean = value
    .replace(/x-access-token:[^@\s]+@github\.com/g, "x-access-token:<redacted>@github.com")
    .replace(/(token|password|secret|api[_-]?key)=\S+/gi, "$1=<redacted>")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD)=\S+/g, "<redacted-secret-env>")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 3)) + "...";
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function pickBool(...values) {
  for (const v of values) {
    if (typeof v === "boolean") return v;
  }
  return false;
}

// ── Lane Steps ──────────────────────────────────────────────────────────

/**
 * Step 1: Evidence dir — verify the deterministic evidence directory exists
 * or can be created, and write a manifest marker.
 */
function evidenceDirCheck(evidenceDir) {
  const dir = resolve(REPO_ROOT, evidenceDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Write a deterministic evidence marker
  const marker = {
    schemaVersion: "a2a.runner.dry-run-evidence-marker.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    evidenceDir,
    ok: true,
  };
  const markerPath = join(dir, "evidence-marker.json");
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));

  // Count entries in the evidence dir
  const entries = readdirSync(dir).filter((e) => !e.startsWith("."));
  return { dirCount: entries.length, dirPath: evidenceDir };
}

/**
 * Step 2: Safe cursor read — produce a deterministic cursor state without
 * any database or state mutation.
 */
function safeCursorRead(fixture) {
  const cursor = fixture.cursorFixture;
  const result = {
    schemaVersion: SCHEMA.CURSOR_READ,
    cursorLabel: safeText(cursor.cursorLabel, 80),
    cursorAt: cursor.cursorAt,
    cursorValid: cursor.cursorValid === true,
    cursorReason: cursor.cursorValid ? undefined : (safeText(cursor.cursorReason, 160) || "Cursor invalid (from fixture)"),
    runIdAtCursor: safeText(cursor.runIdAtCursor, 120) || undefined,
    completedCount: Number.isFinite(cursor.completedCount) ? cursor.completedCount : 0,
    totalCount: Number.isFinite(cursor.totalCount) ? cursor.totalCount : 1,
    mutationPerformed: pickBool(cursor.mutationPerformed, false),
    dbMutationPerformed: pickBool(cursor.dbMutationPerformed, false),
  };

  // Validate safety invariants
  assert.equal(result.mutationPerformed, false, "cursor read must not mutate state");
  assert.equal(result.dbMutationPerformed, false, "cursor read must not mutate DB");

  return result;
}

/**
 * Step 3: operatorEvents restore trap — detect and report any accidental
 * restore attempt. In dry-run mode, the trap is always clean.
 */
function operatorEventsRestoreTrap(fixture) {
  const trapFixture = fixture.operatorEventsTrapFixture;
  const result = {
    schemaVersion: SCHEMA.RESTORE_TRAP,
    trapLabel: safeText(trapFixture.trapLabel, 80),
    triggered: trapFixture.triggered === true,
    detail: safeText(trapFixture.detail, 240) || "not triggered",
    operatorAction: trapFixture.triggered
      ? safeText(trapFixture.operatorAction, 240)
      : undefined,
    restorePerformed: pickBool(trapFixture.restorePerformed, false),
    dbMutationPerformed: pickBool(trapFixture.dbMutationPerformed, false),
  };

  // Validate safety invariants
  assert.equal(result.restorePerformed, false, "restore trap must not perform restore");
  assert.equal(result.dbMutationPerformed, false, "restore trap must not mutate DB");

  return result;
}

/**
 * Step 4: Analysis-only task plan — produce a fresh, bounded plan describing
 * what a real canary task would do, without executing anything.
 */
function analysisTaskPlan(fixture) {
  const planFixture = fixture.analysisTaskPlanFixture;
  const seed = {
    taskLabel: planFixture.taskLabel,
    issueUrl: planFixture.issueUrl,
    analysisDescription: planFixture.analysisDescription,
    run: fixture.run,
    worker: fixture.worker,
  };
  const planId = `dry-run-analysis-${stableDigest(seed)}`;

  const result = {
    schemaVersion: SCHEMA.ANALYSIS_PLAN,
    planId,
    taskLabel: safeText(planFixture.taskLabel, 80),
    issueUrl: planFixture.issueUrl,
    analysisDescription: safeText(planFixture.analysisDescription, 240),
    stepCount: Number.isFinite(planFixture.stepCount) ? planFixture.stepCount : 1,
    planValid: planFixture.planValid === true,
    planInvalidReason: planFixture.planValid ? undefined : (safeText(planFixture.planInvalidReason, 160) || "Plan invalid (from fixture)"),
    executionPerformed: pickBool(planFixture.executionPerformed, false),
    providerSendPerformed: pickBool(planFixture.providerSendPerformed, false),
  };

  // Validate safety invariants
  assert.equal(result.executionPerformed, false, "analysis plan must not execute");
  assert.equal(result.providerSendPerformed, false, "analysis plan must not send");

  return result;
}

/**
 * Step 5: Receipt/ACK evidence fields — produce deterministic receipt
 * evidence without performing any live provider send or ACK.
 */
function receiptEvidence(fixture) {
  const receiptFixture = fixture.receiptEvidenceFixture;
  const acknowledged = receiptFixture.evidenceKind !== "Block";

  const result = {
    schemaVersion: SCHEMA.RECEIPT_EVIDENCE,
    evidenceKind: receiptFixture.evidenceKind,
    terminalOutboxId: safeText(receiptFixture.terminalOutboxId, 120),
    receiptId: safeText(receiptFixture.receiptId, 120),
    channel: safeText(receiptFixture.channel, 40) || "broker-sse",
    url: safeText(receiptFixture.url, 240) || undefined,
    deliveredAt: receiptFixture.deliveredAt,
    acknowledged,
    cursorComplete: acknowledged,
    noLiveProviderSend: pickBool(receiptFixture.noLiveProviderSend, true),
    terminalAckPerformed: pickBool(receiptFixture.terminalAckPerformed, false),
    providerSendSuccessIsReceiptEvidence: pickBool(receiptFixture.providerSendSuccessIsReceiptEvidence, false),
  };

  // Validate safety invariants
  assert.equal(result.noLiveProviderSend, true, "receipt evidence must not perform live provider send");
  assert.equal(result.terminalAckPerformed, false, "receipt evidence must not perform Terminal Brief ACK");
  assert.equal(result.providerSendSuccessIsReceiptEvidence, false, "provider send success is not receipt evidence");

  // Block evidence must NOT be acknowledged
  if (receiptFixture.evidenceKind === "Block") {
    assert.equal(result.acknowledged, false, "Block evidence must not be acknowledged");
  }

  return result;
}

/**
 * Step 6: Compact summary — aggregate all lane fields into a single safe envelope.
 */
function compactSummary(fixture, results) {
  const allOk = results.cursorRead.cursorValid
    && !results.restoreTrap.triggered
    && results.analysisPlan.planValid
    && results.receiptEvidence.noLiveProviderSend
    && !results.receiptEvidence.terminalAckPerformed;

  const summaryParts = [
    `worker=${fixture.worker}`,
    `run=${fixture.run}`,
    `cursorValid=${results.cursorRead.cursorValid}`,
    `restoreTrapTriggered=${results.restoreTrap.triggered}`,
    `planValid=${results.analysisPlan.planValid}`,
    `receiptKind=${results.receiptEvidence.evidenceKind}`,
    `receiptAcked=${results.receiptEvidence.acknowledged}`,
    `evidenceFiles=${results.evidenceDir.dirCount}`,
  ];

  const summary = {
    schemaVersion: SCHEMA.COMPACT_SUMMARY,
    run: safeText(fixture.run, 120),
    worker: safeText(fixture.worker, 48),
    parentIssue: fixture.parentIssue,
    laneIssue: fixture.laneIssue,
    ok: allOk,
    summary: safeText(summaryParts.join(" · "), 360),
    cursorRead: results.cursorRead,
    operatorEventsTrap: results.restoreTrap,
    analysisPlan: results.analysisPlan,
    receiptEvidence: results.receiptEvidence,
    safetyGates: {
      noLiveProviderSend: results.receiptEvidence.noLiveProviderSend,
      terminalAckPerformed: results.receiptEvidence.terminalAckPerformed,
      gatewayRestartPerformed: false,
      dbMutationPerformed: results.cursorRead.dbMutationPerformed
        || results.restoreTrap.dbMutationPerformed,
      providerSendSuccessIsReceiptEvidence: results.receiptEvidence.providerSendSuccessIsReceiptEvidence,
      manualAckReplayPerformed: false,
      historicalReplayPerformed: false,
      restorePerformed: results.restoreTrap.restorePerformed,
    },
    evidenceDirCount: results.evidenceDir.dirCount,
    evidenceDir: "artifacts/dry-run-evidence",
  };

  return summary;
}

/**
 * Top-level lane harness: run all steps and produce the final evidence envelope.
 */
async function runDryRunLane(fixture) {
  // Validate fixture shape
  assert.ok(fixture.run, "fixture must have a run identifier");
  assert.ok(fixture.worker, "fixture must have a worker");
  assert.ok(fixture.parentIssue, "fixture must have a parentIssue");

  // Step 1: Evidence dir
  const evidenceDirResult = await evidenceDirCheck(fixture.evidenceDir || "artifacts/dry-run-evidence");

  // Step 2: Safe cursor read
  const cursorReadResult = safeCursorRead(fixture);
  checkForbidden(JSON.stringify(cursorReadResult), "cursorRead");

  // Step 3: operatorEvents restore trap
  const restoreTrapResult = operatorEventsRestoreTrap(fixture);
  checkForbidden(JSON.stringify(restoreTrapResult), "restoreTrap");

  // Step 4: Analysis-only task plan
  const analysisPlanResult = analysisTaskPlan(fixture);
  checkForbidden(JSON.stringify(analysisPlanResult), "analysisPlan");

  // Step 5: Receipt/ACK evidence fields
  const receiptEvidenceResult = receiptEvidence(fixture);
  checkForbidden(JSON.stringify(receiptEvidenceResult), "receiptEvidence");

  // Step 6: Compact summary
  const compactSummaryResult = compactSummary(fixture, {
    evidenceDir: evidenceDirResult,
    cursorRead: cursorReadResult,
    restoreTrap: restoreTrapResult,
    analysisPlan: analysisPlanResult,
    receiptEvidence: receiptEvidenceResult,
  });
  checkForbidden(JSON.stringify(compactSummaryResult), "compactSummary");

  // Fail-closed check: ensure fixture mustNotContain values are absent
  const serialized = JSON.stringify({
    cursorReadResult,
    restoreTrapResult,
    analysisPlanResult,
    receiptEvidenceResult,
    compactSummaryResult,
  });
  for (const forbidden of fixture.mustNotContain || []) {
    if (serialized.includes(forbidden)) {
      throw new Error(`Evidence leaked forbidden value: ${forbidden}`);
    }
  }

  // Assemble final evidence envelope
  const evidence = {
    schemaVersion: SCHEMA.LANE_EVIDENCE,
    run: safeText(fixture.run, 120),
    worker: safeText(fixture.worker, 48),
    parentIssue: fixture.parentIssue,
    laneIssue: fixture.laneIssue,
    generatedAt: "1970-01-01T00:00:00.000Z",
    compactSummary: compactSummaryResult,
  };

  return evidence;
}

// ── CLI Entry ───────────────────────────────────────────────────────────

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    "Usage: node scripts/broker-ops-docker-dry-run-lane.mjs" +
    " --fixture <path-to-fixture.json>\n",
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--fixture") args.fixture = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.fixture) usage();
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = resolve(process.cwd(), args.fixture);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

  // Write a Start marker comment for evidence traceability
  const startMarker = {
    schemaVersion: "a2a.runner.dry-run-start-marker.v1",
    run: fixture.run,
    worker: fixture.worker,
    parentIssue: fixture.parentIssue,
    laneIssue: fixture.laneIssue,
    startedAt: "1970-01-01T00:00:00.000Z",
    fixture: args.fixture,
    ok: true,
  };
  const startMarkerPath = resolve(
    REPO_ROOT,
    fixture.evidenceDir || "artifacts/dry-run-evidence",
    "start-marker.json",
  );
  const startDir = resolve(
    REPO_ROOT,
    fixture.evidenceDir || "artifacts/dry-run-evidence",
  );
  if (!existsSync(startDir)) {
    mkdirSync(startDir, { recursive: true });
  }
  writeFileSync(startMarkerPath, JSON.stringify(startMarker, null, 2));

  // Run the lane
  const evidence = await runDryRunLane(fixture);

  // Write the evidence output
  const outPath = resolve(
    REPO_ROOT,
    fixture.evidenceDir || "artifacts/dry-run-evidence",
    "broker-ops-docker-dry-run-evidence.json",
  );
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));

  // Print structured result to stdout (canonical output)
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");

} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`broker-ops-docker-dry-run-lane: ${message}\n`);
  process.exit(1);
}
