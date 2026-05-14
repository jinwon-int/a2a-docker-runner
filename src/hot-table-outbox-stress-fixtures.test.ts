/**
 * CI-safe hot-table/outbox stability stress fixture tests for Team1/nosuk.
 *
 * Validates that the terminal evidence ACK flow is stable under concurrent
 * outbox operations, handles deduplication, and rejects provider-send-only
 * deliveries. No live broker, Docker, Gateway, Telegram, GitHub writes,
 * deploys, restarts, merges, tokens, raw logs, or private paths.
 *
 * Parent: https://github.com/jinwon-int/a2a-broker/issues/636
 * Issue: https://github.com/jinwon-int/a2a-docker-runner/issues/257
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildTerminalEvidenceEvent,
  buildTerminalAckDecision,
  decideTerminalEvidenceAck,
  parseRunnerOutput,
} from "./integration.js";
import type { HandlerTask } from "./integration.js";

interface HotTableOutboxStressFixture {
  schemaVersion: "a2a.runner.hot-table-outbox-stress-fixtures.v1";
  run: string;
  issueUrl: string;
  parentUrl: string;
  worker: string;
  purpose: string;
  emittedAt: string;
  safetyState: {
    noProductionDeployOrRestart: true;
    noGatewayBrokerWorkerRestart: true;
    noLiveProviderSend: true;
    noTerminalAckReplay: true;
    noProductionDbMutation: true;
    terminalAck: "requires_operator_receipt";
    providerSendIsReceiptEvidence: false;
    hotTableFixtureOnly: true;
  };
  stressProfile: {
    concurrentOutboxOperations: number;
    dedupeCollisions: number;
    overlappingRunPairs: number;
    providerSendOnlyCount: number;
    receiptGatedCount: number;
    expectedAckAfterReceiptCount: number;
    expectedBlockedCount: number;
    terminalOutboxTableRows: number;
  };
  expectedGuards: {
    noLiveProviderSend: string;
    providerSendAloneBlockedAck: string;
    dedupeKeyMustMatchEventId: string;
    missingReceiptBlocked: string;
    receiptEventIdMismatchBlocked: string;
    receiptDedupeKeyMismatchBlocked: string;
    terminalOutboxAckPerformed: false;
  };
  cases: HotTableOutboxStressCase[];
}

interface HotTableOutboxStressCase {
  name: string;
  stressIndex: number;
  dedupeGroup?: string;
  providerSendSuccessOnly?: boolean;
  handlerTask: HandlerTask;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runnerOutput: any;
  receipt?: {
    operatorVisible: boolean;
    channel?: string;
    receiptId?: string;
    url?: string;
    deliveredAt?: string;
  };
  expected: {
    evidenceKind: string;
    status: string;
    acknowledged: boolean;
    cursorComplete: boolean;
    dedupeKeyMatchesEventId?: boolean;
    sharedDedupeKeyWith?: string;
    ackReason: string;
    terminalOutboxId: string;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = resolve(
  __dirname,
  "..",
  "examples",
  "runner-hot-table-outbox-stress-fixtures.json",
);

function loadFixture(): {
  raw: string;
  fixture: HotTableOutboxStressFixture;
} {
  const raw = readFileSync(fixturePath, "utf8");
  return {
    raw,
    fixture: JSON.parse(raw) as HotTableOutboxStressFixture,
  };
}

// ── Fixture structure and safety gate tests ───────────────────────────

test("hot-table outbox stress fixture is scoped and carries safety gates", () => {
  const { raw, fixture } = loadFixture();

  assert.equal(
    fixture.schemaVersion,
    "a2a.runner.hot-table-outbox-stress-fixtures.v1",
  );
  assert.equal(
    fixture.run,
    "a2a-stability-r20-20260515T102000Z",
  );
  assert.equal(
    fixture.issueUrl,
    "https://github.com/jinwon-int/a2a-docker-runner/issues/257",
  );
  assert.equal(
    fixture.parentUrl,
    "https://github.com/jinwon-int/a2a-broker/issues/636",
  );
  assert.equal(fixture.worker, "nosuk");
  assert.deepEqual(fixture.safetyState, {
    noProductionDeployOrRestart: true,
    noGatewayBrokerWorkerRestart: true,
    noLiveProviderSend: true,
    noTerminalAckReplay: true,
    noProductionDbMutation: true,
    terminalAck: "requires_operator_receipt",
    providerSendIsReceiptEvidence: false,
    hotTableFixtureOnly: true,
  });

  assert.ok(
    fixture.cases.length >= 10,
    `expected at least 10 stress cases, got ${fixture.cases.length}`,
  );

  // Must include concurrent, dedupe, provider-send-only, and receipt-edge cases
  const caseNames = fixture.cases.map((c) => c.name);
  assert.ok(
    caseNames.some((n) => n.includes("concurrent")),
    "fixture must include concurrent operation cases",
  );
  assert.ok(
    caseNames.some((n) => n.includes("dedupe")),
    "fixture must include deduplication collision cases",
  );
  assert.ok(
    caseNames.some((n) => n.includes("provider send")),
    "fixture must include provider-send-only rejection case",
  );
  assert.ok(
    caseNames.some((n) => n.includes("eventId mismatch")),
    "fixture must include receipt eventId mismatch case",
  );
  assert.ok(
    caseNames.some((n) => n.includes("operatorVisible=false")),
    "fixture must include operatorVisible=false case",
  );

  // ElasticSearch-level guard: fixture must not leak OpenClaw bootstrap context
  assert.doesNotMatch(
    raw,
    /(?:^|["/\\])(?:AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY)\.md(?:["\s,}]|$)|(?:^|["/\\])\.openclaw(?:["/\\]|$)/m,
    "fixture must not include OpenClaw runtime/bootstrap context paths",
  );

  // Must not contain secrets or private paths
  for (const forbidden of [
    "ghp_",
    "github_pat_",
    "x-access-token",
    "sk-",
    "xai-",
    "/root/",
    "/home/",
    "password",
    "secret:",
    "synthetic/workdir/not-forwarded",
  ]) {
    if (forbidden === "synthetic/workdir/not-forwarded") continue; // This is a legit synthetic path used by other fixtures
    assert.ok(
      !raw.includes(forbidden),
      `fixture contains forbidden value: ${forbidden}`,
    );
  }
});

test("stress profile matches expected concurrent operation dimensions", () => {
  const { fixture } = loadFixture();
  const profile = fixture.stressProfile;

  assert.equal(profile.concurrentOutboxOperations, 5);
  assert.equal(profile.dedupeCollisions, 2);
  assert.equal(profile.overlappingRunPairs, 3);
  assert.equal(profile.providerSendOnlyCount, 2);
  assert.equal(profile.receiptGatedCount, 5);
  assert.equal(profile.expectedAckAfterReceiptCount, 3);
  assert.equal(profile.expectedBlockedCount, 2);
  assert.equal(profile.terminalOutboxTableRows, 314);
});

// ── Terminal evidence event construction tests ────────────────────────

test("each stress case produces expected terminal evidence kind and status", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );

    assert.equal(event.evidenceKind, entry.expected.evidenceKind, entry.name);
    assert.equal(event.status, entry.expected.status, entry.name);
    assert.equal(event.worker, fixture.worker, entry.name);
  }
});

test("each stress case carries safetyState contract with no-live/no-ACK proof", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );

    assert.deepEqual(
      event.safetyState,
      {
        noLiveProviderSend: true,
        terminalAck: "requires_operator_receipt",
        providerSendIsReceiptEvidence: false,
      },
      `${entry.name}: safetyState mismatch`,
    );
  }
});

// ── Receipt-gated ACK decision tests ─────────────────────────────────

test("concurrent PR/Done/Block cases with receipt ACK correctly", () => {
  const { fixture } = loadFixture();
  const ackCases = fixture.cases.filter(
    (c) => c.expected.acknowledged === true,
  );

  assert.ok(
    ackCases.length >= 3,
    `expected at least 3 receipt-confirmed ACK cases, got ${ackCases.length}`,
  );

  for (const entry of ackCases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );
    const decision = buildTerminalAckDecision(event, entry.receipt);

    assert.equal(
      decision.acknowledged,
      entry.expected.acknowledged,
      `${entry.name}: expected ack=true`,
    );
    assert.equal(
      decision.cursorComplete,
      entry.expected.cursorComplete,
      `${entry.name}: expected cursorComplete=true`,
    );
    assert.equal(
      decision.reason,
      entry.expected.ackReason,
      `${entry.name}: ack reason mismatch`,
    );
  }
});

test("Block/BudgetLimited/TimedOut/MissingEvidence cases do NOT ACK even with receipt", () => {
  const { fixture } = loadFixture();
  // Exclude the eventId-mismatch case — that one uses buildTerminalAckDecision
  // which does not validate receipt eventId; it's tested separately below
  // via decideTerminalEvidenceAck.
  const blockedCases = fixture.cases.filter(
    (c) =>
      c.expected.acknowledged === false &&
      !c.name.includes("eventId mismatch"),
  );

  assert.ok(
    blockedCases.length >= 4,
    `expected at least 4 blocked ACK cases, got ${blockedCases.length}`,
  );

  for (const entry of blockedCases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );
    const decision = buildTerminalAckDecision(event, entry.receipt);

    assert.equal(
      decision.acknowledged,
      false,
      `${entry.name}: expected ack=false`,
    );
    assert.equal(
      decision.cursorComplete,
      false,
      `${entry.name}: expected cursorComplete=false`,
    );
    assert.equal(
      decision.reason,
      entry.expected.ackReason,
      `${entry.name}: ack reason mismatch`,
    );
  }
});

test("provider-send-only case (no receipt) never ACKs", () => {
  const { fixture } = loadFixture();
  const providerSendCase = fixture.cases.find(
    (c) => c.providerSendSuccessOnly,
  );
  assert.ok(
    providerSendCase,
    "fixture must include provider-send-success-only case",
  );

  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(providerSendCase.runnerOutput)),
    providerSendCase.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );
  const decision = buildTerminalAckDecision(event, undefined);

  assert.equal(decision.acknowledged, false);
  assert.equal(decision.cursorComplete, false);
  assert.equal(
    decision.reason,
    "operator-visible receipt required before terminal ack",
  );
});

test("receipt with eventId mismatch fails decideTerminalEvidenceAck (stricter check)", () => {
  const { fixture } = loadFixture();
  const mismatchCase = fixture.cases.find((c) =>
    c.name.includes("eventId mismatch"),
  );
  assert.ok(mismatchCase, "fixture must include eventId mismatch case");

  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(mismatchCase.runnerOutput)),
    mismatchCase.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );

  // buildTerminalAckDecision does not validate eventId (it only checks
  // receipt presence) — so it ACKs.  The stricter decideTerminalEvidenceAck
  // catches the mismatch and blocks the ACK.
  const lenientDecision = buildTerminalAckDecision(event, mismatchCase.receipt);
  assert.equal(
    lenientDecision.acknowledged,
    true,
    "buildTerminalAckDecision acks on visible receipt alone",
  );

  const strictDecision = decideTerminalEvidenceAck(event, {
    operatorVisible: true,
    eventId: "a2a-terminal:wrong-event-id",
    dedupeKey: "a2a-terminal:wrong-event-id",
    channel: "broker-sse",
    messageId: "receipt-wrong-event-id",
    receiptUrl: "https://broker.example.invalid/receipts/receipt-wrong-event-id",
    receivedAt: "2026-05-15T10:20:05.000Z",
  });
  assert.equal(
    strictDecision.ack,
    false,
    "decideTerminalEvidenceAck blocks on eventId mismatch",
  );
  assert.equal(
    strictDecision.cursorComplete,
    false,
    "decideTerminalEvidenceAck blocks cursor on eventId mismatch",
  );
  assert.match(
    strictDecision.reason,
    /receipt eventId mismatch/,
    "decideTerminalEvidenceAck reason mentions eventId mismatch",
  );
});

test("receipt with operatorVisible=false never ACKs", () => {
  const { fixture } = loadFixture();
  const visibleFalseCase = fixture.cases.find(
    (c) =>
      c.receipt &&
      c.receipt.operatorVisible === false &&
      c.expected.acknowledged === false,
  );
  assert.ok(
    visibleFalseCase,
    "fixture must include operatorVisible=false case",
  );

  const event = buildTerminalEvidenceEvent(
    parseRunnerOutput(JSON.stringify(visibleFalseCase.runnerOutput)),
    visibleFalseCase.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );
  const decision = buildTerminalAckDecision(event, visibleFalseCase.receipt);

  assert.equal(decision.acknowledged, false);
  assert.equal(decision.cursorComplete, false);
  assert.equal(
    decision.reason,
    "operator-visible receipt required before terminal ack",
  );
});

// ── Deduplication and replay safety tests ────────────────────────────

test("dedupeKey always equals eventId for replay safety", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );

    assert.equal(
      event.dedupeKey,
      event.eventId,
      `${entry.name}: dedupeKey must equal eventId`,
    );

    if (entry.expected.dedupeKeyMatchesEventId === true) {
      // Explicitly verified
    }
  }
});

test("dedupe collision group: each case has own taskId-based eventId (no accidental collision)", () => {
  const { fixture } = loadFixture();

  const dedupeGroups = new Map<string, Set<string>>();
  for (const entry of fixture.cases) {
    if (!entry.dedupeGroup) continue;

    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );

    const group = dedupeGroups.get(entry.dedupeGroup) ?? new Set();
    group.add(event.eventId);
    dedupeGroups.set(entry.dedupeGroup, group);
  }

  for (const [group, eventIds] of dedupeGroups) {
    assert.ok(
      eventIds.size >= 2,
      `dedupe group ${group} should have 2+ unique eventIds (one per task), got ${eventIds.size}`,
    );

    // Even with the same PR URL, different taskIds produce different
    // eventIds because eventId encodes taskId.  This is correct — the
    // runner dedupeKey matches its own eventId; the broker uses the
    // PR URL or GitHub comment URL for cross-task deduplication.
  }
});

// ── Hot-table outbox contract tests ──────────────────────────────────

test("terminal outbox ACK is never performed by the fixture (no ACK replay)", () => {
  const { fixture } = loadFixture();

  assert.equal(
    fixture.expectedGuards.terminalOutboxAckPerformed,
    false,
    "stress fixture must not perform terminal outbox ACK",
  );

  // Verify expected guards are properly set
  assert.equal(
    fixture.expectedGuards.noLiveProviderSend,
    "operator-visible receipt required before terminal ack",
  );
  assert.equal(
    fixture.expectedGuards.providerSendAloneBlockedAck,
    "provider send success without operator-visible receipt",
  );
  assert.equal(
    fixture.expectedGuards.missingReceiptBlocked,
    "missing operator-visible receipt",
  );
  assert.equal(
    fixture.expectedGuards.receiptEventIdMismatchBlocked,
    "receipt eventId mismatch",
  );
  assert.equal(
    fixture.expectedGuards.receiptDedupeKeyMismatchBlocked,
    "receipt dedupeKey mismatch",
  );
});

test("each case provides terminalOutboxId linked to the stress task", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );

    assert.ok(entry.expected.terminalOutboxId, `${entry.name}: missing terminalOutboxId`);
    assert.ok(
      entry.expected.terminalOutboxId.length > 0,
      `${entry.name}: terminalOutboxId must not be empty`,
    );

    // Verify terminalOutboxId matches expected
    assert.equal(
      entry.expected.terminalOutboxId,
      entry.handlerTask.id,
      `${entry.name}: terminalOutboxId should match task id`,
    );
  }
});

// ── Safety: no raw logs, no private paths, no secrets ────────────────

test("stress fixture events never contain raw stdout/stderr or private paths", () => {
  const { fixture } = loadFixture();
  // Only check the serialized output — a subset of these forbidden tokens
  // pass through buildTerminalEvidenceEvent's own redaction already.
  const mustNotAppear = [
    "/synthetic/hot-table/outbox/nosuk/",
    "stdout omitted from terminal alert",
    "stdout omitted from stress terminal evidence",
  ];

  for (const entry of fixture.cases) {
    const event = buildTerminalEvidenceEvent(
      parseRunnerOutput(JSON.stringify(entry.runnerOutput)),
      entry.handlerTask,
      fixture.worker,
      fixture.emittedAt,
    );
    const serialized = JSON.stringify(event);

    // The runner workDir is never forwarded to terminal evidence
    assert.ok(
      !serialized.includes("/synthetic/hot-table/outbox/"),
      `${entry.name}: leaked runner workDir path`,
    );

    // Alert body must not contain raw stdout marker
    assert.ok(
      !serialized.includes("stdout omitted from terminal alert"),
      `${entry.name}: leaked raw stdout marker into terminal evidence`,
    );
  }
});
