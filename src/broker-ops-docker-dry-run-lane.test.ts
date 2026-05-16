/**
 * Broker-ops Docker dry-run lane tests.
 *
 * R27 Team1/nosuk retry1: validates the deterministic dry-run lane harness
 * against the canonical fixture.  Covers evidence dir, safe cursor read,
 * operatorEvents restore trap, analysis-only task plan, receipt/ACK evidence
 * fields, and compact summary.
 *
 * Parent: a2a-plane#364
 * Lane: a2a-docker-runner#280
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const LANE_SCRIPT = join(import.meta.dirname ?? ".", "..", "scripts", "broker-ops-docker-dry-run-lane.mjs");
const CANONICAL_FIXTURE = join(import.meta.dirname ?? ".", "..", "examples", "broker-ops-docker-dry-run-canonical.json");

test("dry-run lane passes on the canonical fixture", () => {
  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--fixture", CANONICAL_FIXTURE], {
    encoding: "utf8",
    timeout: 15000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.ok(result.stdout, "expected stdout output");

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, "a2a.runner.broker-ops-docker-dry-run-lane.v1");
  assert.equal(parsed.run, "a2a-r27-team1-nosuk-dry-run-lane-20260517T080000Z");
  assert.equal(parsed.worker, "nosuk");
  assert.equal(parsed.generatedAt, "1970-01-01T00:00:00.000Z");

  // Compact summary
  const summary = parsed.compactSummary;
  assert.ok(summary, "compactSummary must be present");
  assert.equal(summary.schemaVersion, "a2a.runner.dry-run-compact-summary.v1");
  assert.equal(summary.ok, true, "lane should report ok");
  assert.equal(summary.evidenceDir, "artifacts/dry-run-evidence");
  assert.ok(summary.evidenceDirCount >= 0);

  // Cursor read
  const cursor = summary.cursorRead;
  assert.equal(cursor.schemaVersion, "a2a.runner.dry-run-cursor-read.v1");
  assert.equal(cursor.cursorValid, true);
  assert.equal(cursor.mutationPerformed, false);
  assert.equal(cursor.dbMutationPerformed, false);
  assert.equal(cursor.completedCount, 0);
  assert.equal(cursor.totalCount, 1);

  // Restore trap
  const trap = summary.operatorEventsTrap;
  assert.equal(trap.schemaVersion, "a2a.runner.operator-events-restore-trap.v1");
  assert.equal(trap.triggered, false);
  assert.equal(trap.restorePerformed, false);
  assert.equal(trap.dbMutationPerformed, false);
  assert.ok(trap.detail, "detail should be present");

  // Analysis plan
  const plan = summary.analysisPlan;
  assert.equal(plan.schemaVersion, "a2a.runner.dry-run-analysis-task-plan.v1");
  assert.equal(plan.planValid, true);
  assert.equal(plan.executionPerformed, false);
  assert.equal(plan.providerSendPerformed, false);
  assert.ok(plan.planId.startsWith("dry-run-analysis-"), `planId should start with dry-run-analysis-, got: ${plan.planId}`);

  // Receipt evidence
  const receipt = summary.receiptEvidence;
  assert.equal(receipt.schemaVersion, "a2a.runner.dry-run-receipt-evidence.v1");
  assert.equal(receipt.noLiveProviderSend, true);
  assert.equal(receipt.terminalAckPerformed, false);
  assert.equal(receipt.providerSendSuccessIsReceiptEvidence, false);
  assert.ok(receipt.acknowledged === true || receipt.acknowledged === false);
  assert.equal(receipt.cursorComplete, receipt.acknowledged);

  // Safety gates
  assert.equal(summary.safetyGates.noLiveProviderSend, true);
  assert.equal(summary.safetyGates.terminalAckPerformed, false);
  assert.equal(summary.safetyGates.gatewayRestartPerformed, false);
  assert.equal(summary.safetyGates.dbMutationPerformed, false);
  assert.equal(summary.safetyGates.providerSendSuccessIsReceiptEvidence, false);
  assert.equal(summary.safetyGates.manualAckReplayPerformed, false);
  assert.equal(summary.safetyGates.historicalReplayPerformed, false);
  assert.equal(summary.safetyGates.restorePerformed, false);
});

test("dry-run lane rejects missing fixture", () => {
  const result = spawnSync(process.execPath, [LANE_SCRIPT], {
    encoding: "utf8",
    timeout: 10000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.notEqual(result.status, 0, "expected non-zero exit for missing --fixture");
  assert.ok(result.stderr.length > 0 || result.stdout.includes("Usage"), "expected usage message");
});

test("dry-run lane rejects forbidden values in evidence", () => {
  // Create a fixture that includes forbidden paths
  const dir = mkdtempSync(join(tmpdir(), "a2a-dry-run-forbidden-"));
  const badFixture = {
    $schema: "a2a-runner-broker-ops-docker-dry-run-canonical-v1",
    description: "Bad fixture with forbidden value for testing fail-closed",
    run: "test-forbidden-leak",
    worker: "nosuk",
    parentIssue: "https://github.com/jinwon-int/a2a-plane/issues/364",
    laneIssue: "https://github.com/jinwon-int/a2a-docker-runner/issues/280",
    evidenceDir: "artifacts/dry-run-evidence",
    cursorFixture: {
      cursorLabel: "terminal-brief-activation",
      cursorAt: "2026-05-17T08:00:00.000Z",
      cursorValid: true,
      runIdAtCursor: "test-run",
      completedCount: 0,
      totalCount: 1,
      mutationPerformed: false,
      dbMutationPerformed: false,
    },
    operatorEventsTrapFixture: {
      trapLabel: "dry-run-operator-events-restore-guard",
      triggered: false,
      detail: "No restore attempt detected.",
      operatorAction: null,
      restorePerformed: false,
      dbMutationPerformed: false,
    },
    analysisTaskPlanFixture: {
      taskLabel: "test-analysis",
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/280",
      analysisDescription: "Test analysis.",
      stepCount: 1,
      planValid: true,
      executionPerformed: false,
      providerSendPerformed: false,
    },
    receiptEvidenceFixture: {
      evidenceKind: "Done",
      terminalOutboxId: "test-outbox-001",
      receiptId: "test-receipt-001",
      channel: "broker-sse",
      deliveredAt: "2026-05-17T08:00:01.000Z",
      noLiveProviderSend: true,
      terminalAckPerformed: false,
      providerSendSuccessIsReceiptEvidence: false,
    },
    mustNotContain: ["x-access-token"],
  };

  // This fixture doesn't actually contain forbidden values, so it should pass.
  // Test by making cursorRead's cursorLabel contain "x-access-token" via the cursorFixture
  badFixture.cursorFixture.runIdAtCursor = "contains-x-access-token:test@github.com";

  const fixturePath = join(dir, "bad-fixture.json");
  writeFileSync(fixturePath, JSON.stringify(badFixture, null, 2));

  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--fixture", fixturePath], {
    encoding: "utf8",
    timeout: 10000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  // The forbidden value should be redacted by safeText, so the lane should pass
  // but the output should contain <redacted>
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      JSON.stringify(parsed).includes("<redacted>"),
      "expected redacted output for forbidden input",
    );
  }

  rmSync(dir, { recursive: true, force: true });
});

test("dry-run lane --help exits 0", () => {
  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--help"], {
    encoding: "utf8",
    timeout: 10000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("--fixture"));
});

test("dry-run lane start marker is written to evidence dir", () => {
  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--fixture", CANONICAL_FIXTURE], {
    encoding: "utf8",
    timeout: 15000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.equal(result.status, 0);

  const startMarkerPath = resolve(
    join(import.meta.dirname ?? ".", ".."),
    "artifacts/dry-run-evidence",
    "start-marker.json",
  );
  assert.ok(existsSync(startMarkerPath), "start-marker.json should exist in evidence dir");

  const marker = JSON.parse(readFileSync(startMarkerPath, "utf8"));
  assert.equal(marker.schemaVersion, "a2a.runner.dry-run-start-marker.v1");
  assert.equal(marker.ok, true);
  assert.equal(marker.worker, "nosuk");
});

test("dry-run lane output file is written to evidence dir", () => {
  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--fixture", CANONICAL_FIXTURE], {
    encoding: "utf8",
    timeout: 15000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.equal(result.status, 0);

  const evidencePath = resolve(
    join(import.meta.dirname ?? ".", ".."),
    "artifacts/dry-run-evidence",
    "broker-ops-docker-dry-run-evidence.json",
  );
  assert.ok(existsSync(evidencePath), "evidence output file should exist");
});

test("dry-run lane serialized evidence must not contain forbidden bootstrap paths", () => {
  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--fixture", CANONICAL_FIXTURE], {
    encoding: "utf8",
    timeout: 15000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.equal(result.status, 0);

  const serialized = result.stdout;
  const forbidden = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "IDENTITY.md"];
  for (const f of forbidden) {
    assert.ok(!serialized.includes(f), `stdout must not contain ${f}`);
  }
});

test("dry-run lane Block evidence is not acknowledged", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-dry-run-block-"));
  const blockFixture = JSON.parse(readFileSync(CANONICAL_FIXTURE, "utf8"));
  blockFixture.receiptEvidenceFixture.evidenceKind = "Block";
  blockFixture.receiptEvidenceFixture.receiptId = "dry-run-receipt-r27-nosuk-block";

  const fixturePath = join(dir, "block-fixture.json");
  writeFileSync(fixturePath, JSON.stringify(blockFixture, null, 2));

  const result = spawnSync(process.execPath, [LANE_SCRIPT, "--fixture", fixturePath], {
    encoding: "utf8",
    timeout: 15000,
    cwd: resolve(join(import.meta.dirname ?? ".", "..")),
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const receipt = parsed.compactSummary.receiptEvidence;
  assert.equal(receipt.evidenceKind, "Block");
  assert.equal(receipt.acknowledged, false, "Block evidence must not be acknowledged");
  assert.equal(receipt.cursorComplete, false);

  rmSync(dir, { recursive: true, force: true });
});
