#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  buildTerminalAckDecision,
  buildTerminalEvidenceEvent,
  parseRunnerOutput,
} from "../dist/integration.js";

const fixturePath = resolve(
  process.cwd(),
  process.argv[2] ?? "examples/runner-canary-parity-jingun-20260511.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

assert.equal(fixture.runnerUpdate, "f17072e");
assert.equal(fixture.worker, "jingun");
assert.equal(fixture.team, "team2");
assert.equal(fixture.canaryContract.noLiveProviderSend, true);
assert.equal(fixture.canaryContract.providerSendSuccessIsReceiptEvidence, false);
assert.equal(fixture.canaryContract.terminalOutboxAckPerformed, false);
assert.equal(fixture.canaryContract.dockerIsolationRequired, true);

const baseline = new Map(
  fixture.team1Baseline.cases.map((entry) => [entry.parityKey, entry]),
);
const observed = [];

for (const entry of fixture.cases) {
  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
    entry.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );
  const decision = buildTerminalAckDecision(event, entry.receipt);
  const expected = entry.expected;
  const team1 = baseline.get(entry.parityKey);

  assert.ok(team1, `${entry.name}: missing Team1 baseline case`);
  assert.equal(event.issueUrl, fixture.issue, `${entry.name}: issue URL`);
  assert.equal(event.worker, fixture.worker, `${entry.name}: worker`);
  assert.equal(event.runnerBuild?.revision, fixture.runnerUpdate, `${entry.name}: runner revision`);
  assert.equal(event.safetyState.noLiveProviderSend, true, `${entry.name}: no live send`);
  assert.equal(event.safetyState.providerSendIsReceiptEvidence, false, `${entry.name}: provider send evidence gate`);
  assert.equal(event.evidenceKind, expected.evidenceKind, `${entry.name}: evidence kind`);
  assert.equal(event.status, expected.status, `${entry.name}: terminal status`);
  assert.equal(decision.acknowledged, expected.acknowledged, `${entry.name}: ack`);
  assert.equal(decision.cursorComplete, expected.cursorComplete, `${entry.name}: cursor`);

  assert.deepEqual(
    {
      evidenceKind: event.evidenceKind,
      status: event.status,
      acknowledged: decision.acknowledged,
      cursorComplete: decision.cursorComplete,
    },
    {
      evidenceKind: team1.evidenceKind,
      status: team1.status,
      acknowledged: team1.acknowledged,
      cursorComplete: team1.cursorComplete,
    },
    `${entry.name}: Team2 result diverged from Team1 baseline`,
  );

  observed.push({
    parityKey: entry.parityKey,
    taskId: event.taskId,
    terminalOutboxId: entry.terminalOutboxId,
    evidenceKind: event.evidenceKind,
    status: event.status,
    acknowledged: decision.acknowledged,
    cursorComplete: decision.cursorComplete,
    reason: decision.reason,
    artifactCount: event.testSummary.artifactCount,
  });
}

assert.equal(observed.length, baseline.size, "Team2 must cover every Team1 baseline case");
assert.ok(observed.some((entry) => entry.acknowledged === false), "must include provider-send-only rejection");
assert.ok(observed.some((entry) => entry.acknowledged === true), "must include receipt-confirmed evidence");

const artifactEvidence = {
  schemaVersion: "a2a.runner.canary-parity-smoke.v1",
  ok: true,
  fixture: relative(process.cwd(), fixturePath).split("\\").join("/"),
  run: fixture.run,
  runnerUpdate: fixture.runnerUpdate,
  issue: fixture.issue,
  parent: fixture.parent,
  worker: fixture.worker,
  team: fixture.team,
  team1Baseline: {
    worker: fixture.team1Baseline.worker,
    issue: fixture.team1Baseline.issue,
  },
  noLiveProviderSend: true,
  terminalOutboxAckPerformed: false,
  providerSendSuccessIsReceiptEvidence: false,
  parity: observed,
};

const serialized = JSON.stringify(artifactEvidence);
for (const forbidden of ["Authorization", "Bearer", "x-access-token", "ghp_", "github_pat_", "/root/", "/home/", "/work/", "raw session"]) {
  assert.ok(!serialized.includes(forbidden), `artifact evidence leaked forbidden value: ${forbidden}`);
}

console.log(JSON.stringify(artifactEvidence, null, 2));
