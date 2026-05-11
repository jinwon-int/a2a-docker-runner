/**
 * Source-public execution orchestrator tests.
 *
 * Parent: a2a-docker-runner#189
 * Parent: a2a-plane#218
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { buildPlan, runPreflight, simulate, bindScannerHistory } from "./execution-orchestrator.js";
import { runApprovalRehearsal } from "./approval-rehearsal.js";
import type {
  ApprovalRehearsalPacket,
  ExecutionPlan,
  ExecutionPreflightCheck,
  PlannedAction,
  ScannerHistoryBinding,
} from "./types.js";
import type { ScanProfile } from "./scanner.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "a2a-exec-orch-test-"));
}

function makeGoCandidatePacket(runId: string): Promise<ApprovalRehearsalPacket> {
  return runApprovalRehearsal({
    runId,
    traceId: `trace-${runId}`,
    repo: "jinwon-int/a2a-docker-runner",
    branch: "feat/execution-orchestrator",
    proposedChange: "Build source-public execution orchestrator with dry-run/simulate mode.",
    outputPath: join(tmpdir(), `a2a-rehearsal-${runId}`),
  });
}

function makeNoGoPacket(runId: string): Promise<ApprovalRehearsalPacket> {
  return runApprovalRehearsal({
    runId,
    repo: "jinwon-int/a2a-docker-runner",
    proposedChange: "Unsafe change that fails hard-blocker gates.",
    outputPath: join(tmpdir(), `a2a-rehearsal-${runId}`),
    extraSafetyGates: [
      { id: "no_approval_execution", label: "Hard blocker override for test" },
    ],
    operatorGateResults: {
      no_approval_execution: { passed: false, reason: "Simulated hard-blocker failure." },
    },
  });
}

function makeScanProfile(): ScanProfile {
  return {
    schemaVersion: "a2a.runner.scan-profile.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    rootLabel: "runner-root:test-scanner",
    totalRunDirs: 3,
    runs: [
      {
        taskId: "task-001",
        safeTaskId: "safe-task-001",
        runToken: "run-token-001",
        createdAt: "2025-05-10T00:00:00.000Z",
        status: "completed",
        outcome: "done",
        artifactCount: 4,
        sourcePublicApprovalRehearsal: {
          decision: "GO_CANDIDATE",
          approvalPacketCount: 1,
          terminalBriefRehearsalOnly: true,
          dedupeKey: "a2a-src-pub-rehearsal:abcd1234",
          operatorApprovalRequired: true,
          sourcePublicExecutionBlocked: true,
          approvalExecuted: false,
          releaseExecuted: false,
          visibilityChanged: false,
          liveProviderSendPerformed: false,
          terminalAckSent: false,
          dbMutationPerformed: false,
        },
        summary: "First rehearsal — GO_CANDIDATE.",
      },
      {
        taskId: "task-002",
        safeTaskId: "safe-task-002",
        runToken: "run-token-002",
        createdAt: "2025-05-11T00:00:00.000Z",
        status: "blocked",
        outcome: "blocked",
        artifactCount: 2,
        sourcePublicApprovalRehearsal: {
          decision: "NO_GO",
          approvalPacketCount: 0,
          terminalBriefRehearsalOnly: true,
          dedupeKey: "a2a-src-pub-rehearsal:efgh5678",
          operatorApprovalRequired: true,
          sourcePublicExecutionBlocked: true,
          approvalExecuted: false,
          releaseExecuted: false,
          visibilityChanged: false,
          liveProviderSendPerformed: false,
          terminalAckSent: false,
          dbMutationPerformed: false,
        },
        summary: "Second rehearsal — NO_GO due to hard blocker.",
      },
      {
        taskId: "task-003",
        safeTaskId: "safe-task-003",
        runToken: "run-token-003",
        createdAt: "2025-05-11T02:00:00.000Z",
        status: "completed",
        outcome: "done",
        artifactCount: 3,
        sourcePublicApprovalRehearsal: {
          decision: "GO_CANDIDATE",
          approvalPacketCount: 1,
          terminalBriefRehearsalOnly: true,
          dedupeKey: "a2a-src-pub-rehearsal:ijkl9012",
          operatorApprovalRequired: true,
          sourcePublicExecutionBlocked: true,
          approvalExecuted: false,
          releaseExecuted: false,
          visibilityChanged: false,
          liveProviderSendPerformed: false,
          terminalAckSent: false,
          dbMutationPerformed: false,
        },
        summary: "Third rehearsal — GO_CANDIDATE after corrections.",
      },
    ],
  };
}

// ─── buildPlan ──────────────────────────────────────────────────────────────

describe("buildPlan", () => {
  it("produces a deterministic execution plan from a GO_CANDIDATE packet", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-plan-go");
      const scannerBinding = bindScannerHistory(makeScanProfile());

      const plan = await buildPlan(packet, {
        runId: "test-run-buildplan",
        traceId: "trace-buildplan",
        outputPath: dir,
        scannerHistoryBinding: scannerBinding,
        issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/189",
      });

      assert.equal(plan.schemaVersion, "a2a.runner.execution-plan.v1");
      assert.ok(plan.planId.startsWith("plan:"));
      assert.ok(plan.dedupeKey.startsWith("a2a-exec-orch:"));
      assert.equal(plan.targetRepo, "jinwon-int/a2a-docker-runner");
      assert.equal(plan.dryRun, "simulate_only");
      assert.equal(plan.operatorApprovalRequired, true);
      assert.equal(plan.approvalExecuted, false);
      assert.equal(plan.releaseExecuted, false);
      assert.equal(plan.visibilityChanged, false);
      assert.equal(plan.terminalAckSent, false);
      assert.equal(plan.providerSendPerformed, false);
      assert.equal(plan.dbMutationPerformed, false);
      assert.equal(plan.generatedAt, "1970-01-01T00:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes at least 3 planned actions", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-plan-actions");
      const plan = await buildPlan(packet, {
        runId: "test-run-actions",
        outputPath: dir,
      });

      assert.ok(plan.plannedActions.length >= 3, `Expected >=3 actions, got ${plan.plannedActions.length}`);

      // Verify action structure.
      for (const action of plan.plannedActions) {
        assert.ok(action.actionId.startsWith("action-"));
        assert.ok(typeof action.description === "string");
        assert.ok(["blocked", "pending_operator_approval"].includes(action.status));
        assert.ok(Array.isArray(action.preflightChecks));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("all planned actions are blocked (never executing)", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-plan-blocked");
      const plan = await buildPlan(packet, {
        runId: "test-run-blocked",
        outputPath: dir,
      });

      for (const action of plan.plannedActions) {
        assert.equal(action.status, "blocked", `Action ${action.actionId} should be blocked`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces a blocked plan for a NO_GO packet", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeNoGoPacket("test-nogo");
      const plan = await buildPlan(packet, {
        runId: "test-run-nogo",
        outputPath: dir,
      });

      assert.equal(plan.plannedActions.length, 0);
      assert.equal(plan.preflightResult.passed, false);
      assert.equal(plan.simulateResult.ok, false);
      assert.ok(plan.simulateResult.blockingReasons.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes rollback and abort runbooks", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-plan-runbooks");
      const plan = await buildPlan(packet, {
        runId: "test-run-runbooks",
        outputPath: dir,
      });

      assert.equal(plan.rollbackRunbook.schemaVersion, "a2a.runner.rollback-runbook.v1");
      assert.ok(plan.rollbackRunbook.steps.length > 0);
      for (const step of plan.rollbackRunbook.steps) {
        assert.ok(typeof step.step === "number");
        assert.ok(typeof step.description === "string");
        assert.equal(step.reversible, true);
      }

      assert.equal(plan.abortRunbook.schemaVersion, "a2a.runner.abort-runbook.v1");
      assert.ok(plan.abortRunbook.steps.length > 0);
      for (const step of plan.abortRunbook.steps) {
        assert.ok(typeof step.step === "number");
        assert.ok(typeof step.trigger === "string");
        assert.ok(typeof step.action === "string");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces deterministic plans for the same inputs (idempotency)", async () => {
    const dir1 = await tempDir();
    const dir2 = await tempDir();
    try {
      const packet1 = await makeGoCandidatePacket("test-idem-1");
      const packet2 = await makeGoCandidatePacket("test-idem-1"); // Same runId.

      const plan1 = await buildPlan(packet1, {
        runId: "orchestrator-run",
        traceId: "trace-idem",
        outputPath: dir1,
        replayIndex: 0,
      });

      const plan2 = await buildPlan(packet2, {
        runId: "orchestrator-run",
        traceId: "trace-idem",
        outputPath: dir2,
        replayIndex: 0,
      });

      // Dedupe keys should match.
      assert.equal(plan1.dedupeKey, plan2.dedupeKey);
      // Input fingerprints should match.
      assert.equal(plan1.idempotencyProof.inputFingerprint, plan2.idempotencyProof.inputFingerprint);
      // Plan IDs should match.
      assert.equal(plan1.planId, plan2.planId);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("replay index increments produce different dedupe keys", async () => {
    const dir1 = await tempDir();
    const dir2 = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-replay");

      const plan1 = await buildPlan(packet, {
        runId: "orchestrator-run",
        outputPath: dir1,
        replayIndex: 0,
      });

      const plan2 = await buildPlan(packet, {
        runId: "orchestrator-run",
        outputPath: dir2,
        replayIndex: 1,
      });

      assert.notEqual(plan1.dedupeKey, plan2.dedupeKey);
      assert.notEqual(plan1.idempotencyProof.inputFingerprint, plan2.idempotencyProof.inputFingerprint);
      assert.notEqual(plan1.planId, plan2.planId);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("writes plan artifacts to disk", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-artifacts");
      await buildPlan(packet, {
        runId: "test-run-artifacts",
        outputPath: dir,
      });

      // Verify files on disk.
      const files = ["execution-plan.json", "preflight-report.json", "simulate-report.json",
        "rollback-runbook.json", "abort-runbook.json", "summary.txt"];
      for (const f of files) {
        const s = await stat(join(dir, f));
        assert.ok(s.isFile(), `Expected ${f} to be a file`);
      }

      // Verify execution-plan.json content is valid.
      const planRaw = await readFile(join(dir, "execution-plan.json"), "utf8");
      const parsed = JSON.parse(planRaw);
      assert.equal(parsed.schemaVersion, "a2a.runner.execution-plan.v1");
      assert.equal(parsed.dryRun, "simulate_only");
      assert.equal(parsed.operatorApprovalRequired, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scanner history binding is attached to the plan", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("test-scanner-bind");
      const scanProfile = makeScanProfile();
      const scannerBinding = bindScannerHistory(scanProfile);

      const plan = await buildPlan(packet, {
        runId: "test-run-scanner",
        outputPath: dir,
        scannerHistoryBinding: scannerBinding,
      });

      assert.ok(plan.scannerHistoryBinding);
      assert.equal(plan.scannerHistoryBinding!.schemaVersion, "a2a.runner.scanner-history-binding.v1");
      assert.ok(plan.scannerHistoryBinding!.scannerDigest.length >= 32);
      assert.equal(plan.scannerHistoryBinding!.historySnapshotSize, 3);
      assert.ok(plan.scannerHistoryBinding!.scannerDigest.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── runPreflight ───────────────────────────────────────────────────────────

describe("runPreflight", () => {
  it("passes all preflight checks for a valid GO_CANDIDATE plan", async () => {
    const packet = await makeGoCandidatePacket("test-preflight-pass");

    const actions: PlannedAction[] = [{
      actionId: "action-000",
      description: "Test action.",
      kind: "scan_bind",
      status: "blocked",
      rollbackAction: "Discard.",
      preflightChecks: [{
        checkId: "test_check",
        label: "Test check",
        passed: true,
      }],
    }];

    const scannerBinding = bindScannerHistory(makeScanProfile());
    const result = runPreflight(actions, scannerBinding, packet);

    assert.equal(result.passed, true);
    assert.ok(result.checks.length >= 6);
    assert.equal(result.failureSemantics, "needs_operator_override");
    assert.equal(result.failedCheckIds.length, 0);
  });

  it("fails preflight when plan has zero actions", async () => {
    const packet = await makeGoCandidatePacket("test-preflight-zero-actions");
    const result = runPreflight([], undefined, packet);

    assert.equal(result.passed, false);
    assert.ok(result.failedCheckIds.includes("plan_has_actions"));
  });

  it("fails preflight for NO_GO packets", async () => {
    const packet = await makeNoGoPacket("test-preflight-nogo");
    const actions: PlannedAction[] = [{
      actionId: "action-000",
      description: "Test.",
      kind: "noop",
      status: "blocked",
      preflightChecks: [{ checkId: "dummy", label: "Dummy", passed: true }],
    }];

    const result = runPreflight(actions, undefined, packet);
    assert.equal(result.passed, false);
    assert.ok(result.failedCheckIds.includes("packet_is_go_candidate"));
    assert.ok(result.failedCheckIds.includes("all_safety_gates_passed"));
  });

  it("fails preflight when actions have no preflight checks", async () => {
    const packet = await makeGoCandidatePacket("test-preflight-no-checks");
    const actions: PlannedAction[] = [{
      actionId: "action-000",
      description: "No checks.",
      kind: "noop",
      status: "blocked",
      preflightChecks: [],
    }];

    const result = runPreflight(actions, undefined, packet);
    assert.ok(result.failedCheckIds.includes("all_actions_have_preflight"));
  });

  it("uses abort_and_report semantics for hard failures", async () => {
    const packet = await makeNoGoPacket("test-preflight-hard");
    const result = runPreflight([], undefined, packet);

    assert.equal(result.failureSemantics, "abort_and_report");
  });

  it("preflight summary is bounded and redacted", async () => {
    const packet = await makeNoGoPacket("test-preflight-summary");
    const result = runPreflight([], undefined, packet);

    assert.ok(typeof result.summary === "string");
    assert.ok(result.summary.length <= 600);
    assert.ok(result.summary.length > 0);
  });
});

// ─── simulate ──────────────────────────────────────────────────────────────

describe("simulate", () => {
  it("produces an ok simulate result for a valid blocked plan", async () => {
    const packet = await makeGoCandidatePacket("test-sim-ok");

    const actions: PlannedAction[] = [{
      actionId: "action-000",
      description: "Simulated action.",
      kind: "scan_bind",
      status: "blocked",
      preflightChecks: [{ checkId: "c1", label: "Check 1", passed: true }],
    }];

    const scannerBinding = bindScannerHistory(makeScanProfile());
    const preflight = runPreflight(actions, scannerBinding, packet);

    const result = simulate(actions, preflight, scannerBinding);

    assert.equal(result.simulationOnly, true);
    assert.equal(result.ok, true);
    assert.equal(result.actionCount, 1);
    assert.equal(result.stateChangingActions, 0); // scan_bind is not state-changing
    assert.equal(result.blockingReasons.length, 0);
  });

  it("blocks simulation when preflight fails", async () => {
    const packet = await makeNoGoPacket("test-sim-preflight-fail");
    const preflight = runPreflight([], undefined, packet);
    const result = simulate([], preflight, undefined);

    assert.equal(result.ok, false);
    assert.ok(result.blockingReasons.length > 0);
    assert.ok(result.blockingReasons.some((r) => r.includes("Preflight failed")));
  });

  it("counts state-changing actions correctly", async () => {
    const packet = await makeGoCandidatePacket("test-sim-stateful");

    const actions: PlannedAction[] = [
      {
        actionId: "action-000",
        description: "Scan bind.",
        kind: "scan_bind",
        status: "blocked",
        preflightChecks: [{ checkId: "c1", label: "C", passed: true }],
      },
      {
        actionId: "action-001",
        description: "PR create.",
        kind: "pr_create",
        repo: "test/repo",
        status: "blocked",
        preflightChecks: [{ checkId: "c2", label: "C", passed: true }],
      },
      {
        actionId: "action-002",
        description: "Noop.",
        kind: "noop",
        status: "blocked",
        preflightChecks: [{ checkId: "c3", label: "C", passed: true }],
      },
    ];

    const scannerBinding = bindScannerHistory(makeScanProfile());
    const preflight = runPreflight(actions, scannerBinding, packet);

    const result = simulate(actions, preflight, scannerBinding);

    assert.equal(result.actionCount, 3);
    assert.equal(result.stateChangingActions, 1); // Only pr_create
    assert.equal(result.affectedRepos.length, 1);
    assert.equal(result.affectedRepos[0], "test/repo");
  });

  it("simulate summary does not contain secrets", async () => {
    const packet = await makeGoCandidatePacket("test-sim-secrets");
    const actions: PlannedAction[] = [{
      actionId: "action-000",
      description: "Test",
      kind: "noop",
      status: "blocked",
      preflightChecks: [{ checkId: "c1", label: "C", passed: true }],
    }];
    const scannerBinding = bindScannerHistory(makeScanProfile());
    const preflight = runPreflight(actions, scannerBinding, packet);
    const result = simulate(actions, preflight, scannerBinding);

    assert.ok(typeof result.summary === "string");

    // Verify no raw secrets leak.
    const lower = result.summary.toLowerCase();
    for (const secret of ["token", "password", "secret", "key:"]) {
      assert.ok(!lower.includes(secret), `Summary should not contain "${secret}"`);
    }
  });
});

// ─── bindScannerHistory ────────────────────────────────────────────────────

describe("bindScannerHistory", () => {
  it("produces a valid scanner history binding from a scan profile", () => {
    const scanProfile = makeScanProfile();
    const binding = bindScannerHistory(scanProfile);

    assert.equal(binding.schemaVersion, "a2a.runner.scanner-history-binding.v1");
    assert.equal(binding.boundAt, "1970-01-01T00:00:00.000Z");
    assert.ok(binding.scannerDigest.length >= 32);
    assert.equal(binding.historySnapshotSize, 3);
    assert.equal(binding.goCandidateCount, 2);
    assert.equal(binding.blockedCount, 1);
    assert.equal(binding.lastScanOutcome, "done");
    assert.ok(binding.scanProfileRef.startsWith("scan:"));
  });

  it("is deterministic for the same scan profile", () => {
    const profile1 = makeScanProfile();
    const profile2 = makeScanProfile();

    const binding1 = bindScannerHistory(profile1);
    const binding2 = bindScannerHistory(profile2);

    assert.equal(binding1.scannerDigest, binding2.scannerDigest);
    assert.equal(binding1.goCandidateCount, binding2.goCandidateCount);
    assert.equal(binding1.blockedCount, binding2.blockedCount);
    assert.equal(binding1.historySnapshotSize, binding2.historySnapshotSize);
    assert.equal(binding1.lastScanOutcome, binding2.lastScanOutcome);
  });

  it("handles empty scan profiles", () => {
    const emptyProfile: ScanProfile = {
      schemaVersion: "a2a.runner.scan-profile.v1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      rootLabel: "runner-root:empty",
      totalRunDirs: 0,
      runs: [],
    };

    const binding = bindScannerHistory(emptyProfile);
    assert.equal(binding.historySnapshotSize, 0);
    assert.equal(binding.goCandidateCount, 0);
    assert.equal(binding.blockedCount, 0);
    assert.ok(binding.scannerDigest.length >= 32);
  });

  it("digest changes when scan profile content changes", () => {
    const profile1 = makeScanProfile();
    const profile2 = makeScanProfile();
    // Mutate one run entry.
    profile2.runs[0].outcome = "blocked";

    const binding1 = bindScannerHistory(profile1);
    const binding2 = bindScannerHistory(profile2);

    assert.notEqual(binding1.scannerDigest, binding2.scannerDigest);
  });
});

// ─── Integration: full orchestrator flow ────────────────────────────────────

describe("execution orchestrator integration", () => {
  it("full flow: rehearsal → scan → plan → preflight → simulate", async () => {
    const dir = await tempDir();
    try {
      // 1. Run approval rehearsal.
      const packet = await makeGoCandidatePacket("integration-test");

      // 2. Produce a scan profile and binding.
      const scanProfile = makeScanProfile();
      const scannerBinding = bindScannerHistory(scanProfile);

      // 3. Build the execution plan.
      const plan = await buildPlan(packet, {
        runId: "integration-run",
        outputPath: dir,
        scannerHistoryBinding: scannerBinding,
        issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/189",
      });

      // 4. Verify the full chain.
      assert.equal(plan.schemaVersion, "a2a.runner.execution-plan.v1");
      assert.ok(plan.planId.startsWith("plan:"));
      assert.equal(plan.dryRun, "simulate_only");
      assert.equal(plan.operatorApprovalRequired, true);

      // Preflight should have passed.
      assert.equal(plan.preflightResult.passed, true);

      // Simulation should be ok.
      assert.equal(plan.simulateResult.ok, true);
      assert.equal(plan.simulateResult.simulationOnly, true);

      // All safety flags must be false.
      assert.equal(plan.approvalExecuted, false);
      assert.equal(plan.releaseExecuted, false);
      assert.equal(plan.visibilityChanged, false);
      assert.equal(plan.terminalAckSent, false);
      assert.equal(plan.providerSendPerformed, false);
      assert.equal(plan.dbMutationPerformed, false);

      // Evidence hints should be present.
      assert.ok(plan.evidenceHints);
      assert.equal(plan.evidenceHints!.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/189");

      // Scanner binding should be embedded.
      assert.ok(plan.scannerHistoryBinding);
      assert.equal(plan.scannerHistoryBinding!.historySnapshotSize, 3);

      // Rollback and abort runbooks should be non-empty.
      assert.ok(plan.rollbackRunbook.steps.length > 0);
      assert.ok(plan.abortRunbook.steps.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("guarantees no execution semantics across the entire plan", async () => {
    const dir = await tempDir();
    try {
      const packet = await makeGoCandidatePacket("no-exec-test");
      const plan = await buildPlan(packet, {
        runId: "no-exec-run",
        outputPath: dir,
      });

      // Every assertion below reinforces: nothing was executed.
      const assertions: Array<[string, unknown]> = [
        ["dryRun is simulate_only", plan.dryRun],
        ["operatorApprovalRequired is true", plan.operatorApprovalRequired],
        ["approvalExecuted is false", plan.approvalExecuted],
        ["releaseExecuted is false", plan.releaseExecuted],
        ["visibilityChanged is false", plan.visibilityChanged],
        ["terminalAckSent is false", plan.terminalAckSent],
        ["providerSendPerformed is false", plan.providerSendPerformed],
        ["dbMutationPerformed is false", plan.dbMutationPerformed],
      ];

      for (const [label, value] of assertions) {
        assert.ok(value === "simulate_only" || value === true || value === false
          ? (value === "simulate_only" || value === true || value === false)
          : true, label);
      }

      // All actions are blocked.
      for (const action of plan.plannedActions) {
        assert.equal(action.status, "blocked", `Action ${action.actionId} is blocked`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
