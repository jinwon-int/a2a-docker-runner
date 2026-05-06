#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTerminalAckDecision, buildTerminalEvidenceEvent, parseRunnerOutput } from "../dist/integration.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/terminal-brief-receipt-r4-canonical.json", import.meta.url), "utf8"));
const requiredKinds = new Set(fixture.canonicalCloseout.allowedEvidenceKinds);
const artifacts = [];

assert.equal(fixture.canonicalCloseout.noLiveProviderSend, true, "fixture must be no-live");
assert.equal(fixture.canonicalCloseout.terminalOutboxAckPerformed, false, "fixture must not record a terminal-outbox ACK");
assert.equal(fixture.canonicalCloseout.providerSendSuccessIsReceiptEvidence, false, "provider send success is not receipt evidence");

for (const entry of fixture.cases) {
  assert.ok(entry.terminalOutboxId, `${entry.name}: terminalOutboxId is required`);
  assert.ok(entry.runId, `${entry.name}: runId is required`);

  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
    entry.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );
  const decision = buildTerminalAckDecision(event, entry.receipt);

  requiredKinds.delete(event.evidenceKind);
  assert.equal(event.issueUrl, fixture.issue, `${entry.name}: canonical issue URL`);
  assert.equal(event.safetyState.noLiveProviderSend, true, `${entry.name}: no live send`);
  assert.equal(event.safetyState.terminalAck, "requires_operator_receipt", `${entry.name}: ACK requires receipt`);
  assert.equal(event.safetyState.providerSendIsReceiptEvidence, false, `${entry.name}: provider send is not receipt evidence`);
  assert.equal(event.status, entry.expected.status, `${entry.name}: terminal status`);
  assert.equal(event.evidenceKind, entry.expected.evidenceKind, `${entry.name}: evidence kind`);
  assert.equal(decision.acknowledged, entry.expected.acknowledged, `${entry.name}: acknowledged`);
  assert.equal(decision.cursorComplete, entry.expected.cursorComplete, `${entry.name}: cursorComplete`);

  artifacts.push({
    taskId: event.taskId,
    terminalOutboxId: entry.terminalOutboxId,
    runId: entry.runId,
    status: event.status,
    evidenceKind: event.evidenceKind,
    testSummary: event.testSummary,
    ack: {
      acknowledged: decision.acknowledged,
      cursorComplete: decision.cursorComplete,
      reason: decision.reason,
    },
  });
}

assert.deepEqual([...requiredKinds], [], "fixture must cover canonical PR/Done/Block evidence kinds");
const serialized = JSON.stringify({ artifacts });
for (const forbidden of fixture.mustNotContain) {
  assert.ok(!serialized.includes(forbidden), `safe artifact report leaked forbidden value: ${forbidden}`);
}

console.log(JSON.stringify({
  ok: true,
  schemaVersion: "a2a.runner.terminal-brief-receipt-r4-smoke.v1",
  run: fixture.run,
  issue: fixture.issue,
  parent: fixture.parent,
  worker: fixture.worker,
  noLiveProviderSend: true,
  terminalOutboxAckPerformed: false,
  providerSendSuccessIsReceiptEvidence: false,
  artifacts,
}, null, 2));
