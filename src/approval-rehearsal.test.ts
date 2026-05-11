/**
 * Source-public approval rehearsal tests.
 *
 * Parent: a2a-docker-runner#185
 * Parent: a2a-plane#211
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { runApprovalRehearsal } from "./approval-rehearsal.js";
import type { ApprovalRehearsalPacket } from "./types.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "a2a-approval-rehearsal-test-"));
}

describe("runApprovalRehearsal", () => {
  it("produces a GO_CANDIDATE packet when all safety gates pass", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-go-candidate",
        traceId: "trace-001",
        repo: "jinwon-int/a2a-docker-runner",
        branch: "feat/source-public-rehearsal",
        proposedChange: "Add source-public approval rehearsal module",
        outputPath: dir,
      });

      assert.equal(packet.schemaVersion, "a2a.runner.approval-rehearsal.v1");
      assert.equal(packet.generatedAt, "1970-01-01T00:00:00.000Z");
      assert.equal(packet.decision, "GO_CANDIDATE");
      assert.ok(packet.decisionReason.includes("All safety gates passed"));
      assert.equal(packet.runId, "test-run-go-candidate");
      assert.equal(packet.traceId, "trace-001");
      assert.equal(packet.repo, "jinwon-int/a2a-docker-runner");
      assert.equal(packet.branch, "feat/source-public-rehearsal");
      assert.equal(packet.proposedChange, "Add source-public approval rehearsal module");

      // Idempotency proof
      assert.ok(packet.idempotencyProof.dedupeKey.startsWith("a2a-src-pub-rehearsal:"));
      assert.equal(packet.idempotencyProof.wasExecuted, false);
      assert.equal(packet.idempotencyProof.replayIndex, 0);
      assert.ok(typeof packet.idempotencyProof.inputFingerprint === "string");
      assert.equal(packet.idempotencyProof.inputFingerprint.length, 32);

      // Safety gates
      assert.ok(packet.safetyGates.length >= 10);
      for (const gate of packet.safetyGates) {
        assert.equal(gate.passed, true, `Gate ${gate.id} should pass`);
        assert.ok(typeof gate.id === "string");
        assert.ok(typeof gate.label === "string");
      }

      // Abort and rollback paths
      assert.ok(packet.abortPaths.length > 0);
      assert.ok(packet.rollbackPaths.length > 0);
      assert.ok(packet.abortPaths.some((p) => p.includes("delete the approval rehearsal packet")));
      assert.ok(packet.rollbackPaths.some((p) => p.includes("no state was mutated")));

      // Evidence bundle
      assert.equal(packet.evidenceBundlePath, "manifest.json");

      // Files on disk
      const entry = await stat(join(dir, "manifest.json"));
      assert.ok(entry.isFile());
      const entry2 = await stat(join(dir, "summary.txt"));
      assert.ok(entry2.isFile());
      const entry3 = await stat(join(dir, "safety-gates.json"));
      assert.ok(entry3.isFile());
      const entry4 = await stat(join(dir, "approval-rehearsal-packet.json"));
      assert.ok(entry4.isFile());

      // Verify packet file content
      const packetRaw = await readFile(join(dir, "approval-rehearsal-packet.json"), "utf8");
      const parsed = JSON.parse(packetRaw);
      assert.equal(parsed.decision, "GO_CANDIDATE");
      assert.equal(parsed.schemaVersion, "a2a.runner.approval-rehearsal.v1");

      // Verify manifest content
      const manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      assert.equal(manifest.artifactVersion, 1);
      assert.equal(manifest.status, "done");
      assert.ok(Array.isArray(manifest.evidence));
      assert.ok(manifest.evidence.length >= 2);
      assert.ok(manifest.summary.includes("GO_CANDIDATE"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces a NO_GO packet when hard-blocker gates are marked failed", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-no-go",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Deploy to production",
        outputPath: dir,
        operatorGateResults: {
          no_live_provider_send: { passed: false, reason: "Live Telegram send detected in task plan" },
          no_approval_execution: { passed: false, reason: "Execution flag set in task payload" },
        },
      });

      assert.equal(packet.decision, "NO_GO");
      assert.ok(packet.decisionReason.includes("Hard-blocker"));
      assert.ok(packet.decisionReason.includes("no_live_provider_send"));
      assert.ok(packet.decisionReason.includes("no_approval_execution"));

      // Verify gates
      const providerGate = packet.safetyGates.find((g) => g.id === "no_live_provider_send");
      assert.ok(providerGate);
      assert.equal(providerGate.passed, false);
      assert.equal(providerGate.reason, "Live Telegram send detected in task plan");

      const execGate = packet.safetyGates.find((g) => g.id === "no_approval_execution");
      assert.ok(execGate);
      assert.equal(execGate.passed, false);

      // Manifest should be blocked
      const manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      assert.equal(manifest.status, "blocked");
      assert.ok(manifest.summary.includes("NO_GO"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces a NEEDS_OPERATOR_APPROVAL packet when non-blocker gates fail", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-needs-approval",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Update CI workflow",
        outputPath: dir,
        operatorGateResults: {
          no_production_deploy: { passed: false, reason: "CI workflow change may affect deployment pipeline" },
          no_automatic_merge_approval: { passed: false, reason: "Requires operator review of CI changes" },
        },
      });

      assert.equal(packet.decision, "NEEDS_OPERATOR_APPROVAL");
      assert.ok(packet.decisionReason.includes("no_production_deploy"));
      assert.ok(packet.decisionReason.includes("no_automatic_merge_approval"));

      // Verify gates
      const deployGate = packet.safetyGates.find((g) => g.id === "no_production_deploy");
      assert.ok(deployGate);
      assert.equal(deployGate.passed, false);

      // Manifest should be blocked
      const manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      assert.equal(manifest.status, "blocked");
      assert.ok(manifest.summary.includes("NEEDS_OPERATOR_APPROVAL"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic — same inputs produce identical dedupe keys and fingerprints", async () => {
    const dir1 = await tempDir();
    const dir2 = await tempDir();
    try {
      const opts = {
        runId: "test-run-deterministic",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test deterministic output",
        outputPath: "", // placeholder
      };

      const p1 = await runApprovalRehearsal({ ...opts, outputPath: dir1 });
      const p2 = await runApprovalRehearsal({ ...opts, outputPath: dir2 });

      // Idempotency proof must be identical for identical logical inputs.
      assert.equal(p1.idempotencyProof.dedupeKey, p2.idempotencyProof.dedupeKey);
      assert.equal(p1.idempotencyProof.inputFingerprint, p2.idempotencyProof.inputFingerprint);
      assert.equal(p1.idempotencyProof.wasExecuted, p2.idempotencyProof.wasExecuted);
      assert.equal(p1.idempotencyProof.replayIndex, p2.idempotencyProof.replayIndex);

      // Decision must match.
      assert.equal(p1.decision, p2.decision);
      assert.equal(p1.decisionReason, p2.decisionReason);

      // Generated timestamps must be deterministic.
      assert.equal(p1.generatedAt, "1970-01-01T00:00:00.000Z");
      assert.equal(p2.generatedAt, "1970-01-01T00:00:00.000Z");
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("increments replayIndex across replays", async () => {
    const dir1 = await tempDir();
    const dir2 = await tempDir();
    try {
      const opts = {
        runId: "test-run-replay",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test replay index",
        outputPath: "",
      };

      const p1 = await runApprovalRehearsal({ ...opts, outputPath: dir1, replayIndex: 0 });
      const p2 = await runApprovalRehearsal({ ...opts, outputPath: dir2, replayIndex: 1 });

      assert.equal(p1.idempotencyProof.replayIndex, 0);
      assert.equal(p2.idempotencyProof.replayIndex, 1);
      // Same dedupe key across replays (same logical task).
      assert.equal(p1.idempotencyProof.dedupeKey, p2.idempotencyProof.dedupeKey);
      // replayIndex differentiates them.
      assert.notEqual(p1.idempotencyProof.replayIndex, p2.idempotencyProof.replayIndex);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("includes evidence hints when issueUrl is provided", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-with-issue",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test with issue URL",
        outputPath: dir,
        issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/185",
      });

      assert.ok(packet.evidenceHints);
      assert.equal(packet.evidenceHints!.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/185");
      assert.equal(packet.evidenceHints!.schemaVersion, "a2a.runner.evidence-hints.v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports extra safety gates", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-extra-gates",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test extra gates",
        outputPath: dir,
        extraSafetyGates: [
          { id: "custom_gate_1", label: "Custom safety gate for operator policy" },
          { id: "custom_gate_2", label: "Another custom policy gate" },
        ],
      });

      const custom1 = packet.safetyGates.find((g) => g.id === "custom_gate_1");
      assert.ok(custom1);
      assert.equal(custom1.passed, true);
      assert.equal(custom1.label, "Custom safety gate for operator policy");

      const custom2 = packet.safetyGates.find((g) => g.id === "custom_gate_2");
      assert.ok(custom2);
      assert.equal(custom2.passed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces valid evidence bundle manifest on disk", async () => {
    const dir = await tempDir();
    try {
      await runApprovalRehearsal({
        runId: "test-run-evidence-bundle",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test evidence bundle integrity",
        outputPath: dir,
      });

      // manifest.json
      const manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      assert.equal(manifest.artifactVersion, 1);
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.manifestPath, "manifest.json");
      assert.equal(manifest.generatedAt, "1970-01-01T00:00:00.000Z");
      assert.equal(manifest.status, "done");
      assert.ok(typeof manifest.summary === "string");
      assert.ok(manifest.summary.length > 0);
      assert.ok(Array.isArray(manifest.evidence));
      assert.ok(manifest.evidence.length >= 2);
      assert.ok(Array.isArray(manifest.artifacts));
      assert.ok(manifest.artifacts.length >= 2);

      // safety-gates.json
      const gatesRaw = await readFile(join(dir, "safety-gates.json"), "utf8");
      const gates = JSON.parse(gatesRaw);
      assert.equal(gates.schemaVersion, "a2a.runner.approval-rehearsal-safety-gates.v1");
      assert.ok(Array.isArray(gates.gates));
      assert.ok(gates.idempotencyProof);
      assert.equal(gates.generatedAt, "1970-01-01T00:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("abort paths are always populated even for GO_CANDIDATE", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-abort-paths",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test abort paths",
        outputPath: dir,
      });

      assert.equal(packet.decision, "GO_CANDIDATE");
      assert.ok(packet.abortPaths.length > 0, "GO_CANDIDATE must have abort paths");
      assert.ok(packet.rollbackPaths.length > 0, "GO_CANDIDATE must have rollback paths");
      assert.ok(packet.abortPaths.some((p) => p.toLowerCase().includes("abort")));
      assert.ok(packet.rollbackPaths.some((p) => p.toLowerCase().includes("rollback")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rehearsal_round_only and no_approval_execution gates are always present", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-rehearsal-gates",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test rehearsal-only gates",
        outputPath: dir,
      });

      const rehearsalGate = packet.safetyGates.find((g) => g.id === "rehearsal_round_only");
      assert.ok(rehearsalGate, "rehearsal_round_only gate must be present");
      assert.ok(rehearsalGate.label.toLowerCase().includes("never executes"));

      const approvalExecGate = packet.safetyGates.find((g) => g.id === "no_approval_execution");
      assert.ok(approvalExecGate, "no_approval_execution gate must be present");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cross-scenario safety gates cover all required check categories", async () => {
    const dir = await tempDir();
    try {
      const packet = await runApprovalRehearsal({
        runId: "test-run-cross-scenario",
        repo: "jinwon-int/a2a-docker-runner",
        proposedChange: "Test safety gate coverage",
        outputPath: dir,
      });

      const expectedGates = [
        "no_production_deploy",
        "no_gateway_broker_worker_restart",
        "no_live_provider_send",
        "no_terminal_ack",
        "no_production_db_mutation",
        "no_secret_or_visibility_change",
        "no_history_rewrite",
        "no_release_publication",
        "no_automatic_merge_approval",
        "no_approval_execution",
        "rehearsal_round_only",
      ];

      for (const gateId of expectedGates) {
        const found = packet.safetyGates.find((g) => g.id === gateId);
        assert.ok(found, `Safety gate '${gateId}' must be present`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
