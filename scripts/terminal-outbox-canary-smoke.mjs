#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTerminalAckDecision,
  buildTerminalEvidenceEvent,
  parseRunnerOutput,
} from "../dist/integration.js";

const fixturePath = resolve(
  process.cwd(),
  process.argv[2] ?? "examples/terminal-outbox-canary-nosuk-20260511.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

assert.equal(fixture.run, "terminal-brief-activation-20260511T080211Z");
assert.equal(fixture.worker, "nosuk");
assert.equal(fixture.canaryContract.noLiveProviderSend, true);
assert.equal(
  fixture.canaryContract.providerSendSuccessIsReceiptEvidence,
  false,
);
assert.equal(fixture.canaryContract.terminalOutboxAckPerformed, false);

const artifacts = [];

for (const entry of fixture.cases) {
  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
    entry.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );

  let ackDecision;
  if (entry.providerSendSuccessOnly) {
    // Provider send success only — receipt has operatorVisible: false
    ackDecision = buildTerminalAckDecision(event, entry.receipt);
  } else {
    ackDecision = buildTerminalAckDecision(event, entry.receipt);
  }

  // Validate evidence kind and status
  assert.equal(event.evidenceKind, entry.expected.evidenceKind, entry.name);
  assert.equal(event.status, entry.expected.status, entry.name);

  // Validate terminal-outbox ack decision
  assert.equal(
    ackDecision.acknowledged,
    entry.expected.acknowledged,
    `${entry.name}: ack mismatch`,
  );
  assert.equal(
    ackDecision.cursorComplete,
    entry.expected.cursorComplete,
    `${entry.name}: cursor mismatch`,
  );

  // terminalOutboxId must match the case entry
  if (entry.terminalOutboxId) {
    assert.ok(entry.terminalOutboxId, `${entry.name}: missing terminalOutboxId`);
  }

  // Serialize and check for leaks
  const serialized = JSON.stringify({ event, ackDecision });
  for (const forbidden of fixture.mustNotContain ?? []) {
    assert.ok(
      !serialized.includes(forbidden),
      `${entry.name} leaked forbidden value: ${forbidden}`,
    );
  }

  artifacts.push({
    name: entry.name,
    taskId: event.taskId,
    terminalOutboxId: entry.terminalOutboxId,
    evidenceKind: event.evidenceKind,
    status: event.status,
    acknowledged: ackDecision.acknowledged,
    cursorComplete: ackDecision.cursorComplete,
  });
}

// Smoke must include both provider-send-only rejection AND receipt-confirmed ack
assert.ok(
  artifacts.some((a) => a.acknowledged === false),
  "must include a provider-send-only blocked ACK case",
);
assert.ok(
  artifacts.some((a) => a.acknowledged === true),
  "must include a receipt-confirmed ACK case",
);

assert.equal(fixture.canaryContract.terminalOutboxAckPerformed, false);

const result = {
  ok: true,
  fixture: fixturePath,
  run: fixture.run,
  worker: fixture.worker,
  issue: fixture.issue,
  terminalOutboxAckPerformed: false,
  artifacts,
};

console.log(JSON.stringify(result, null, 2));
