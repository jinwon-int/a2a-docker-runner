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

const reports = fixture.cases.map((entry) => buildCanaryRecoveryAuditReport(
  parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
  entry.handlerTask,
  fixture.worker,
  entry.receipt,
  fixture.emittedAt,
));

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
