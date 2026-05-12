#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  buildCanaryRecoveryAuditReport,
  parseRunnerOutput,
} from "../dist/integration.js";

const fixturePath = resolve(
  process.cwd(),
  process.argv[2] ?? "examples/runner-canary-parity-jingun-20260511.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

assert.equal(fixture.worker, "jingun");
assert.equal(fixture.team, "team2");
assert.equal(fixture.canaryContract.noLiveProviderSend, true);
assert.equal(fixture.canaryContract.providerSendSuccessIsReceiptEvidence, false);
assert.equal(fixture.canaryContract.terminalOutboxAckPerformed, false);

function buildReports() {
  return fixture.cases.map((entry) => buildCanaryRecoveryAuditReport(
    parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
    entry.handlerTask,
    fixture.worker,
    entry.receipt,
    fixture.emittedAt,
  ));
}

const reports = buildReports();
const replayReports = buildReports();

// Recovery proof must be replay-safe: identical bounded inputs and the same
// emittedAt timestamp must produce identical event ids, dedupe keys, operator
// actions, and cursor decisions. This stays entirely synthetic/no-live.
assert.deepEqual(replayReports, reports);

const dedupeKeys = new Set(reports.map((report) => report.dedupeKey));
assert.equal(dedupeKeys.size, reports.length, "each terminal outcome must have a unique replay dedupe key");
assert.ok(reports.every((report) => report.eventId === report.dedupeKey), "event id should be the adapter idempotency key");

const expectedByTaskId = new Map(fixture.cases.map((entry) => [entry.handlerTask.id, entry.expected]));
for (const report of reports) {
  const expected = expectedByTaskId.get(report.taskId);
  assert.ok(expected, `fixture missing expected matrix for ${report.taskId}`);
  assert.equal(report.evidenceKind, expected.evidenceKind, report.taskId);
  assert.equal(report.status, expected.status, report.taskId);
  assert.equal(report.acknowledged, expected.acknowledged, report.taskId);
  assert.equal(report.cursorComplete, expected.cursorComplete, report.taskId);
}

const providerSendOnly = reports.find((report) => report.taskId.includes("send-only"));
assert.ok(providerSendOnly, "must include provider-send-only recovery case");
assert.equal(providerSendOnly.acknowledged, false);
assert.equal(providerSendOnly.cursorComplete, false);
assert.equal(providerSendOnly.operatorAction, "operator_visible_receipt_required");

const receiptConfirmed = reports.filter((report) => report.acknowledged === true && report.cursorComplete === true);
assert.ok(receiptConfirmed.length >= 3, "PR/Done/Block receipt-confirmed cases should complete cursor");

assert.equal(reports.length, fixture.cases.length);
assert.ok(reports.some((report) => report.operatorAction === "operator_visible_receipt_required"), "must flag missing operator-visible receipt");
assert.ok(reports.some((report) => report.cursorComplete === true), "must include receipt-confirmed recovery path");
assert.ok(reports.every((report) => report.safetyState.noLiveProviderSend === true));
assert.ok(reports.every((report) => report.safetyState.providerSendIsReceiptEvidence === false));
assert.ok(reports.every((report) => report.safetyState.terminalAck === "requires_operator_receipt"));
assert.ok(reports.every((report) => report.diagnostics.artifactCount != null), "diagnostics should include bounded artifact counts");

const artifactEvidence = {
  schemaVersion: "a2a.runner.canary-recovery-audit-smoke.v1",
  ok: true,
  fixture: relative(process.cwd(), fixturePath).split("\\").join("/"),
  run: fixture.run,
  issue: fixture.issue,
  parent: fixture.parent,
  worker: fixture.worker,
  team: fixture.team,
  noLiveProviderSend: true,
  providerSendSuccessIsReceiptEvidence: false,
  terminalOutboxAckPerformed: false,
  replayProof: {
    deterministic: true,
    replayCount: replayReports.length,
    uniqueDedupeKeys: dedupeKeys.size,
    providerSendOnlyDoesNotAck: providerSendOnly.acknowledged === false && providerSendOnly.cursorComplete === false,
    receiptConfirmedCompletesCursor: receiptConfirmed.length,
    terminalAckRequiresOperatorVisibleReceipt: true,
    noLiveProviderSend: true,
    terminalOutboxAckPerformed: false,
  },
  reports,
};

const serialized = JSON.stringify(artifactEvidence);
for (const forbidden of [
  "Authorization",
  "Bearer",
  "x-access-token",
  "ghp_",
  "github_pat_",
  "/root/",
  "/home/",
  "/work/",
  "raw session",
  "messageId",
]) {
  assert.ok(!serialized.includes(forbidden), `artifact evidence leaked forbidden value: ${forbidden}`);
}

console.log(JSON.stringify(artifactEvidence, null, 2));
