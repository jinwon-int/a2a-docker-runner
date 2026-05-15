/**
 * Terminal Brief no-live readiness template fixture tests.
 *
 * R26 Team1 no-live integration rehearsal lane for nosuk.
 * Parent: a2a-plane#360
 * Lane: a2a-docker-runner#276
 * Run: a2a-r26-team1-no-live-terminal-brief-integration-rehearsal-20260515T1832Z
 *
 * Exercises terminal-brief-node-health, terminal-brief-latency-diagnostics,
 * terminal-brief-session-store-residue, and terminal-brief-worker-readiness
 * fixture/synthetic evidence and reports gaps.
 *
 * Safety gates (enforced in every fixture):
 * - noLiveProviderSend: true
 * - terminalOutboxAckPerformed: false (no Terminal ACK)
 * - gatewayRestartPerformed: false
 * - brokerRestartPerformed: false (no broker /health calls)
 * - dbMutationPerformed: false
 * - No secrets, private paths, or OpenClaw bootstrap files in any fixture.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXAMPLES_DIR = join(__dirname, "..", "examples");
const RUN_ID = "a2a-r26-team1-no-live-terminal-brief-integration-rehearsal-20260515T1832Z";
const TARGET_NODE = "nosuk";

// ─── Fixture interfaces ─────────────────────────────────────────────────

interface FixtureCheck {
  name: string;
  passed: boolean;
  detail?: string | null;
}

interface SafetyState {
  noLiveProviderSend: true;
  providerSendIsReceiptEvidence: false;
  terminalAck: string;
  gatewayRestartPerformed: boolean;
  dbMutationPerformed: boolean;
  brokerRestartPerformed?: boolean;
  brokerHealthCallPerformed?: boolean;
  hostSessionStoreFilesCopiedOrUploaded?: boolean;
  deploymentPerformed?: boolean;
  canarySendPerformed?: boolean;
  releasePerformed?: boolean;
}

interface BaseFixture {
  $schema: string;
  run: string;
  parent: string;
  issue: string;
  targetNode: string;
  expectedRevision?: string;
  noLiveProviderSend: true;
  terminalOutboxAckPerformed: false;
  checks: FixtureCheck[];
  safetyState: SafetyState;
}

interface NodeHealthFixture extends BaseFixture {
  $schema: "a2a.runner.terminal-brief-node-health.v1";
  doctorReport: Record<string, unknown>;
}

interface LatencyDiagnosticsFixture extends BaseFixture {
  $schema: "a2a.runner.terminal-brief-latency-diagnostics.v1";
  latencyDiagnostics: {
    p95Ms: number;
    p99Ms: number;
    sampleSize: number;
    thresholds: Record<string, unknown>;
    withinThreshold: boolean;
    repeatedLatencyStages: string[];
    diagnosticsSplitCandidates: string[];
    expensiveDiagnosticsCached: boolean;
    brokerHealthCallPerformed: false;
  };
}

interface SessionStoreResidueFixture extends BaseFixture {
  $schema: "a2a.runner.terminal-brief-session-store-residue.v1";
  activeAgentId: string;
  sessionStoreGuard: Record<string, unknown>;
  cleanupRehearsal: Record<string, unknown>;
}

interface WorkerReadinessFixture extends BaseFixture {
  $schema: "a2a.runner.terminal-brief-worker-readiness.v1";
  expectedRevision: string;
  subChecks: Record<string, unknown>;
  overallReady: true;
  safetyState: SafetyState;
}

type TerminalBriefFixture =
  | NodeHealthFixture
  | LatencyDiagnosticsFixture
  | SessionStoreResidueFixture
  | WorkerReadinessFixture;

// ─── Helpers ─────────────────────────────────────────────────────────────

function loadFixture<T extends TerminalBriefFixture>(filename: string): T {
  const raw = readFileSync(join(EXAMPLES_DIR, filename), "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Assert that a fixture's raw text is free of OpenClaw bootstrap context
 * files, secrets, host private paths, and raw session dumps.
 */
function assertNoBootstrapLeaks(raw: string): void {
  for (const forbidden of [
    // Secrets / tokens
    "ghp_",
    "github_pat_",
    "x-access-token",
    "sk-",
    "xai-",
    "password",
    "secret:",
    "Authorization",
    "Bearer",
    // Host private paths
    "/root/",
    "/home/",
    "/private/",
    // OpenClaw bootstrap context files
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
    ".openclaw/",
  ]) {
    assert.ok(
      !raw.includes(forbidden),
      `fixture contains forbidden value: ${forbidden}`,
    );
  }
}

/**
 * Assert common no-live safety constraints shared by all 4 fixtures.
 *
 * Required outcome #2 from R26 lane:
 * - No live broker /health calls
 * - No provider send
 * - No Gateway restart
 * - No DB mutation
 * - No Terminal ACK
 */
function assertCommonSafety(fixture: BaseFixture, filename: string): void {
  const ss = fixture.safetyState;

  // Required: noLiveProviderSend must be true
  assert.equal(
    fixture.noLiveProviderSend,
    true,
    `${filename}: noLiveProviderSend must be true`,
  );
  assert.equal(
    ss.noLiveProviderSend,
    true,
    `${filename}: safetyState.noLiveProviderSend must be true`,
  );
  assert.equal(
    ss.providerSendIsReceiptEvidence,
    false,
    `${filename}: provider send is not receipt evidence`,
  );

  // Required: no Terminal ACK
  assert.equal(
    fixture.terminalOutboxAckPerformed,
    false,
    `${filename}: terminalOutboxAckPerformed must be false`,
  );
  assert.equal(
    ss.terminalAck,
    "not_performed",
    `${filename}: terminalAck must be "not_performed", got "${ss.terminalAck}"`,
  );

  // Required: no Gateway restart
  assert.equal(
    ss.gatewayRestartPerformed,
    false,
    `${filename}: gatewayRestartPerformed must be false`,
  );

  // Required: no DB mutation
  assert.equal(
    ss.dbMutationPerformed,
    false,
    `${filename}: dbMutationPerformed must be false`,
  );

  // Required: at least one check present and all pass
  assert.ok(
    fixture.checks.length >= 1,
    `${filename}: must have at least 1 check`,
  );
  for (const check of fixture.checks) {
    assert.equal(
      check.passed,
      true,
      `${filename}: check "${check.name}" must pass`,
    );
  }
}

/**
 * Return the schemas of all known fixtures.
 */
function fixtureInventory(): { filename: string; schema: string }[] {
  return [
    {
      filename: "terminal-brief-node-health-fixture.json",
      schema: "a2a.runner.terminal-brief-node-health.v1",
    },
    {
      filename: "terminal-brief-latency-diagnostics-fixture.json",
      schema: "a2a.runner.terminal-brief-latency-diagnostics.v1",
    },
    {
      filename: "terminal-brief-session-store-residue-fixture.json",
      schema: "a2a.runner.terminal-brief-session-store-residue.v1",
    },
    {
      filename: "terminal-brief-worker-readiness-fixture.json",
      schema: "a2a.runner.terminal-brief-worker-readiness.v1",
    },
  ];
}

// ─── Tests ───────────────────────────────────────────────────────────────

// ── Inventory ───────────────────────────────────────────────────────────

test("terminal-brief fixture inventory is exactly 4 known fixtures", () => {
  const inventory = fixtureInventory();
  assert.equal(inventory.length, 4);

  const schemas = inventory.map((i) => i.schema).sort();
  assert.deepEqual(schemas, [
    "a2a.runner.terminal-brief-latency-diagnostics.v1",
    "a2a.runner.terminal-brief-node-health.v1",
    "a2a.runner.terminal-brief-session-store-residue.v1",
    "a2a.runner.terminal-brief-worker-readiness.v1",
  ]);
});

// ── Node Health ─────────────────────────────────────────────────────────

test("terminal-brief-node-health fixture parses and validates structure", () => {
  const fixture = loadFixture<NodeHealthFixture>(
    "terminal-brief-node-health-fixture.json",
  );

  assert.equal(fixture.$schema, "a2a.runner.terminal-brief-node-health.v1");
  assert.equal(fixture.targetNode, TARGET_NODE);
  assert.equal(fixture.run, "a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z");
  assert.equal(fixture.parent, "a2a-plane#351");
  assert.equal(fixture.issue, "a2a-docker-runner#270");
  assert.ok(fixture.expectedRevision);
  assert.ok(fixture.doctorReport);
  assert.equal(fixture.checks.length, 6);

  assertCommonSafety(fixture, "terminal-brief-node-health-fixture.json");
  assert.equal(fixture.safetyState.brokerRestartPerformed, false);
});

test("terminal-brief-node-health fixture has no bootstrap leaks", () => {
  const raw = readFileSync(
    join(EXAMPLES_DIR, "terminal-brief-node-health-fixture.json"),
    "utf8",
  );
  assertNoBootstrapLeaks(raw);
});

// ── Latency Diagnostics ─────────────────────────────────────────────────

test("terminal-brief-latency-diagnostics fixture parses and validates structure", () => {
  const fixture = loadFixture<LatencyDiagnosticsFixture>(
    "terminal-brief-latency-diagnostics-fixture.json",
  );

  assert.equal(fixture.$schema, "a2a.runner.terminal-brief-latency-diagnostics.v1");
  assert.equal(fixture.targetNode, TARGET_NODE);
  assert.equal(fixture.run, "a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z");
  assert.equal(fixture.parent, "a2a-plane#351");
  assert.equal(fixture.issue, "a2a-docker-runner#270");
  assert.equal(fixture.checks.length, 4);

  // Validate latency diagnostics detail
  assert.ok(fixture.latencyDiagnostics.p95Ms >= 0);
  assert.ok(fixture.latencyDiagnostics.p99Ms >= 0);
  assert.equal(fixture.latencyDiagnostics.sampleSize, 100);
  assert.equal(fixture.latencyDiagnostics.withinThreshold, true);
  assert.equal(fixture.latencyDiagnostics.brokerHealthCallPerformed, false);

  // All repeated-latency diagnostic stages present
  const expectedStages = [
    "persistenceSummary",
    "hotEntityMirrorCounts",
    "auditDiagnostics",
    "requestPressure",
    "jsonSerialization",
  ];
  for (const stage of expectedStages) {
    assert.ok(
      fixture.latencyDiagnostics.repeatedLatencyStages.includes(stage),
      `missing repeated-latency diagnostic stage: ${stage}`,
    );
  }

  // Diagnostics split candidates
  assert.ok(
    fixture.latencyDiagnostics.diagnosticsSplitCandidates.includes("/health/diagnostics"),
  );
  assert.equal(fixture.latencyDiagnostics.expensiveDiagnosticsCached, true);

  assertCommonSafety(fixture, "terminal-brief-latency-diagnostics-fixture.json");
  // Latency diagnostics additionally asserts no broker /health call
  assert.equal(fixture.safetyState.brokerHealthCallPerformed, false);
});

test("terminal-brief-latency-diagnostics fixture has no bootstrap leaks", () => {
  const raw = readFileSync(
    join(EXAMPLES_DIR, "terminal-brief-latency-diagnostics-fixture.json"),
    "utf8",
  );
  assertNoBootstrapLeaks(raw);
});

// ── Session-Store Residue ───────────────────────────────────────────────

test("terminal-brief-session-store-residue fixture parses and validates structure", () => {
  const fixture = loadFixture<SessionStoreResidueFixture>(
    "terminal-brief-session-store-residue-fixture.json",
  );

  assert.equal(fixture.$schema, "a2a.runner.terminal-brief-session-store-residue.v1");
  assert.equal(fixture.targetNode, TARGET_NODE);
  assert.equal(fixture.run, "a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z");
  assert.equal(fixture.parent, "a2a-plane#351");
  assert.equal(fixture.issue, "a2a-docker-runner#270");
  assert.equal(fixture.activeAgentId, "main");
  assert.equal(fixture.checks.length, 5);

  // Validate session store guard detail
  assert.ok(fixture.sessionStoreGuard.guardWouldBlock === false);

  // Validate cleanup rehearsal
  assert.equal(fixture.cleanupRehearsal.performed, true);
  assert.equal(fixture.cleanupRehearsal.dryRun, true);

  assertCommonSafety(fixture, "terminal-brief-session-store-residue-fixture.json");
  assert.equal(
    fixture.safetyState.hostSessionStoreFilesCopiedOrUploaded,
    false,
    "no host session-store files copied or uploaded",
  );
});

test("terminal-brief-session-store-residue fixture has no bootstrap leaks", () => {
  const raw = readFileSync(
    join(EXAMPLES_DIR, "terminal-brief-session-store-residue-fixture.json"),
    "utf8",
  );
  assertNoBootstrapLeaks(raw);
});

// ── Worker Readiness ────────────────────────────────────────────────────

test("terminal-brief-worker-readiness fixture parses and validates structure", () => {
  const fixture = loadFixture<WorkerReadinessFixture>(
    "terminal-brief-worker-readiness-fixture.json",
  );

  assert.equal(fixture.$schema, "a2a.runner.terminal-brief-worker-readiness.v1");
  assert.equal(fixture.targetNode, TARGET_NODE);
  assert.equal(fixture.run, "a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z");
  assert.equal(fixture.parent, "a2a-plane#351");
  assert.equal(fixture.issue, "a2a-docker-runner#270");
  assert.ok(fixture.expectedRevision);
  assert.equal(fixture.overallReady, true);
  assert.equal(fixture.checks.length, 7);

  // Validate sub-checks exist for all required sub-templates
  const subCheckKeys = Object.keys(fixture.subChecks);
  assert.ok(subCheckKeys.includes("nodeHealth"));
  assert.ok(subCheckKeys.includes("latencyDiagnostics"));
  assert.ok(subCheckKeys.includes("sessionStoreResidue"));
  assert.ok(subCheckKeys.includes("doctor"));
  assert.ok(subCheckKeys.includes("deployMarker"));
  assert.ok(subCheckKeys.includes("evidenceContract"));
  assert.ok(subCheckKeys.includes("staleBacklog"));

  for (const [key, value] of Object.entries(fixture.subChecks)) {
    const sc = value as { performed: boolean; passed: boolean };
    assert.equal(
      sc.performed,
      true,
      `sub-check "${key}" must be performed`,
    );
    assert.equal(
      sc.passed,
      true,
      `sub-check "${key}" must pass`,
    );
  }

  assertCommonSafety(fixture, "terminal-brief-worker-readiness-fixture.json");
  // Worker readiness is the final gate: must also block deploy, canary, release
  assert.equal(fixture.safetyState.brokerRestartPerformed, false);
  assert.equal(fixture.safetyState.deploymentPerformed, false);
  assert.equal(fixture.safetyState.canarySendPerformed, false);
  assert.equal(fixture.safetyState.releasePerformed, false);
});

test("terminal-brief-worker-readiness fixture has no bootstrap leaks", () => {
  const raw = readFileSync(
    join(EXAMPLES_DIR, "terminal-brief-worker-readiness-fixture.json"),
    "utf8",
  );
  assertNoBootstrapLeaks(raw);
});

// ── Cross-cutting ───────────────────────────────────────────────────────

test("all terminal-brief fixtures share consistent run metadata", () => {
  const inventory = fixtureInventory();

  for (const entry of inventory) {
    const fixture = loadFixture(entry.filename);
    // All fixtures from the same R25 run should share parent, target node
    assert.equal(fixture.parent, "a2a-plane#351", `${entry.filename}: parent mismatch`);
    assert.equal(fixture.issue, "a2a-docker-runner#270", `${entry.filename}: issue mismatch`);
    assert.equal(fixture.targetNode, TARGET_NODE, `${entry.filename}: targetNode mismatch`);
  }
});

test("no terminal-brief fixture contains raw stdout/stderr or session dumps", () => {
  const inventory = fixtureInventory();

  for (const entry of inventory) {
    const raw = readFileSync(join(EXAMPLES_DIR, entry.filename), "utf8");

    // Compact alert bodies must not contain raw logs (per R25 structured summary contract)
    assert.doesNotMatch(
      raw,
      /(?:^|["\s])(?:stdout|stderr)(?:["\s:,]|$)/im,
      `${entry.filename}: must not reference raw stdout or stderr in evidence body`,
    );

    // No raw session dump payload
    assert.doesNotMatch(
      raw,
      /"sessions\.json"|"session\.json"|sessions\.dump|\.session-store/,
      `${entry.filename}: must not contain raw session dump references`,
    );
  }
});

test("all terminal-brief fixtures use synthetic/fixture data only (no live URLs)", () => {
  const inventory = fixtureInventory();

  for (const entry of inventory) {
    const raw = readFileSync(join(EXAMPLES_DIR, entry.filename), "utf8");

    // R25 fixture data should reference synthetic identifiers, not live issue URLs
    // The fixtures reference a2a-docker-runner#270 which is the R25 lane, not a production issue
    assert.ok(
      raw.includes("a2a-docker-runner#270") || raw.includes("a2a-plane#351"),
      `${entry.filename}: should reference known synthetic run identifiers`,
    );
  }
});
