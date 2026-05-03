#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTerminalAckDecision,
  buildTerminalEvidenceEvent,
  parseRunnerOutput,
} from "../dist/integration.js";

const fixturePath = resolve(process.cwd(), process.argv[2] ?? "examples/runner-telegram-terminal-notification-smoke.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const event = buildTerminalEvidenceEvent(
  parseRunnerOutput(JSON.stringify(fixture.runnerOutput)),
  fixture.handlerTask,
  fixture.worker,
  fixture.emittedAt,
);

const decisions = [];
for (const step of fixture.steps ?? []) {
  const decision = buildTerminalAckDecision(event, step.receipt);
  assert.equal(decision.acknowledged, step.expectedAck.acknowledged, step.name);
  assert.equal(decision.cursorComplete, step.expectedAck.cursorComplete, step.name);
  assert.equal(decision.reason, step.expectedAck.reason, step.name);

  if (step.receipt) {
    assert.equal(step.receipt.channel, "telegram", `${step.name}: receipt channel must be telegram`);
    assert.ok(step.receipt.receiptId || step.receipt.url || step.receipt.deliveredAt, `${step.name}: receipt must include operator-visible evidence`);
  } else {
    assert.equal(step.providerSendOk, true, `${step.name}: negative case must model provider send success only`);
  }

  decisions.push({ name: step.name, acknowledged: decision.acknowledged, cursorComplete: decision.cursorComplete, reason: decision.reason });
}

assert.ok(decisions.some((entry) => entry.acknowledged === false), "smoke must include a pre-receipt blocked ACK step");
assert.ok(decisions.some((entry) => entry.acknowledged === true), "smoke must include a receipt-confirmed ACK step");

const safePayload = JSON.stringify({ event, decisions });
for (const forbidden of fixture.safety?.mustNotContain ?? []) {
  assert.ok(!safePayload.includes(forbidden), `smoke output leaked forbidden value: ${forbidden}`);
}

console.log(JSON.stringify({ ok: true, fixture: fixturePath, eventId: event.eventId, decisions }, null, 2));
