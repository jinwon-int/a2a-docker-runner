import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildArtifactManifest, buildResultSummary, buildSourcePublicApprovalRehearsal, redactAndBound } from "./runner.js";
import {
  buildSourcePublicExecutionPreflight,
  digestStableJson,
  sanitizeSourcePublicExecutionPreflight,
} from "./source-public-preflight.js";
import type { ArtifactManifest } from "./types.js";
import type { ScanProfile } from "./scanner.js";

function sampleManifest(): ArtifactManifest {
  return {
    artifactVersion: 1,
    schemaVersion: 1,
    manifestPath: "artifacts/manifest.json",
    generatedAt: "1970-01-01T00:00:00.000Z",
    taskId: "source-public-preflight-task",
    repo: "jinwon-int/a2a-docker-runner",
    branch: "main",
    issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/190",
    status: "done",
    summary: "Approved evidence packet ready for final execution preflight.",
    evidence: [{ kind: "file", label: "approval-packet", status: "passed", path: "source-public-approval.json" }],
    artifacts: [{ path: "source-public-approval.json", name: "source-public-approval.json", sizeBytes: 120 }],
  };
}

function sampleScanProfile(): ScanProfile {
  return {
    schemaVersion: "a2a.runner.scan-profile.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:tasks",
    totalRunDirs: 1,
    runs: [{
      taskId: "source-public-preflight-task",
      safeTaskId: "source-public-preflight-task",
      runToken: "20260511T023207Z",
      createdAt: "2026-05-11T02:32:07.000Z",
      status: "done",
      outcome: "done",
      artifactCount: 1,
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/190",
      summary: "Approved evidence packet ready for final execution preflight.",
    }],
  };
}

function goPacket() {
  return buildSourcePublicApprovalRehearsal({
    targetRepo: "jinwon-int/a2a-docker-runner",
    decision: "GO_CANDIDATE",
    runId: "a2a-source-public-execution-orchestrator-20260511T023207Z",
  }).approvalPackets[0]!;
}

test("buildSourcePublicExecutionPreflight creates deterministic operator-gated simulate plan", () => {
  const manifest = sampleManifest();
  const scanProfile = sampleScanProfile();
  const packet = goPacket();

  const first = buildSourcePublicExecutionPreflight({
    approvedPacket: packet,
    manifest,
    scanProfile,
    mode: "simulate",
    runId: "a2a-source-public-execution-orchestrator-20260511T023207Z",
  });
  const second = buildSourcePublicExecutionPreflight({
    approvedPacket: packet,
    manifest,
    scanProfile,
    mode: "simulate",
    runId: "a2a-source-public-execution-orchestrator-20260511T023207Z",
  });

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, "a2a.runner.source-public-execution-preflight.v1");
  assert.equal(first.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(first.mode, "simulate");
  assert.equal(first.status, "ready_for_operator_approval");
  assert.equal(first.approvedPacket.decision, "GO_CANDIDATE");
  assert.equal(first.scannerHistoryBinding.manifestDigest, digestStableJson(manifest));
  assert.equal(first.scannerHistoryBinding.historyDigest, digestStableJson(scanProfile));
  assert.equal(first.scannerHistoryBinding.historyRunCount, 1);
  assert.equal(first.executionPlan.operatorGate, "explicit_operator_approval_required");
  assert.equal(first.executionPlan.dryRunOnly, true);
  assert.equal(first.executionPlan.simulateOnly, true);
  assert.equal(first.executionPlan.liveExecutionBlocked, true);
  assert.ok(first.executionPlan.actions.length >= 3);
  for (const action of first.executionPlan.actions) {
    assert.equal(action.requiresExplicitOperatorApproval, true);
    assert.equal(action.dryRunOnly, true);
    assert.equal(action.sideEffectPerformed, false);
  }
  assert.equal(first.safetyGates.approvalExecuted, false);
  assert.equal(first.safetyGates.releaseExecuted, false);
  assert.equal(first.safetyGates.visibilityChanged, false);
  assert.equal(first.safetyGates.liveProviderSendPerformed, false);
  assert.equal(first.safetyGates.terminalAckSent, false);
  assert.equal(first.safetyGates.dbMutationPerformed, false);
  assert.equal(first.safetyGates.deployOrRestartPerformed, false);
});

test("buildSourcePublicExecutionPreflight fails closed for missing scanner/history or manifest mismatch", () => {
  const packet = goPacket();
  const manifest = sampleManifest();
  const missingHistory = buildSourcePublicExecutionPreflight({ approvedPacket: packet, manifest });

  assert.equal(missingHistory.status, "blocked");
  assert.equal(missingHistory.preflightFailureSemantics.failClosed, true);
  assert.equal(missingHistory.preflightFailureSemantics.missingScannerHistory, true);
  assert.ok(missingHistory.preflightFailureSemantics.reasons.includes("scanner/history evidence is missing"));

  const mismatch = buildSourcePublicExecutionPreflight({
    approvedPacket: packet,
    manifest,
    scanProfile: sampleScanProfile(),
    expectedManifestDigest: "0".repeat(64),
  });
  assert.equal(mismatch.status, "blocked");
  assert.equal(mismatch.preflightFailureSemantics.manifestMismatch, true);
});

test("buildSourcePublicExecutionPreflight blocks non-GO approval packets", () => {
  const packet = buildSourcePublicApprovalRehearsal({
    targetRepo: "jinwon-int/a2a-docker-runner",
    decision: "NEEDS_OPERATOR_APPROVAL",
    runId: "a2a-source-public-execution-orchestrator-20260511T023207Z",
  }).approvalPackets[0]!;

  const preflight = buildSourcePublicExecutionPreflight({
    approvedPacket: packet,
    manifest: sampleManifest(),
    scanProfile: sampleScanProfile(),
  });

  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.preflightFailureSemantics.approvalPacketNotGoCandidate, true);
  assert.ok(preflight.preflightFailureSemantics.reasons.includes("approval packet decision is not GO_CANDIDATE"));
});

test("sanitizeSourcePublicExecutionPreflight rejects any live side-effect flag", () => {
  const safe = buildSourcePublicExecutionPreflight({
    approvedPacket: goPacket(),
    manifest: sampleManifest(),
    scanProfile: sampleScanProfile(),
  });
  const unsafeAction = structuredClone(safe);
  unsafeAction.executionPlan.actions[0]!.sideEffectPerformed = true as false;
  assert.equal(sanitizeSourcePublicExecutionPreflight(unsafeAction), undefined);

  const unsafeGate = structuredClone(safe);
  unsafeGate.safetyGates.deployOrRestartPerformed = true as false;
  assert.equal(sanitizeSourcePublicExecutionPreflight(unsafeGate), undefined);
});

test("artifact manifest and result summary preserve sanitized source-public execution preflight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-source-public-preflight-"));
  try {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    const artifact = join(dir, "artifacts", "source-public-execution-preflight.json");
    await writeFile(artifact, "synthetic source-public execution preflight only");
    const preflight = buildSourcePublicExecutionPreflight({
      approvedPacket: goPacket(),
      manifest: sampleManifest(),
      scanProfile: sampleScanProfile(),
      mode: "dry_run",
    });

    const manifest = await buildArtifactManifest(dir, [artifact], { status: "done", sourcePublicExecutionPreflight: preflight });
    const summary = buildResultSummary(
      { code: 0, signal: null, stdout: "ok", stderr: "", timedOut: false },
      redactAndBound("ok"),
      "",
      [artifact],
      manifest,
    );

    assert.equal(manifest.sourcePublicExecutionPreflight?.status, "ready_for_operator_approval");
    assert.equal(manifest.sourcePublicExecutionPreflight?.executionPlan.dryRunOnly, true);
    assert.deepEqual(summary.sourcePublicExecutionPreflight, manifest.sourcePublicExecutionPreflight);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
