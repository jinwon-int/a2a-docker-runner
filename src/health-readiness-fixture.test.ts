/**
 * CI-safe broker /health readiness fixture tests.
 *
 * Validates fixture/tooling support for repeated latency diagnostics and
 * no-live proof without touching a live broker, Gateway, provider, terminal ACK,
 * or production database.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildRunnerTaskFromHandlerPayload } from "./integration.js";
import type { HandlerTask } from "./integration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface BrokerHealthReadinessFixture {
  description: string;
  source: {
    issue: string;
    parent: string;
    rootHealthIssue: string;
    runId: string;
  };
  handlerTask: HandlerTask;
  probePlan: {
    endpoint: string;
    method: string;
    sampleSize: number;
    latencyThresholdsMs: {
      p95: number;
      p99: number;
    };
    repeatedLatencyDiagnostics: string[];
    smallDbFixture: {
      syntheticOnly: boolean;
      approxSizeMb: number;
      tables: Record<string, number>;
    };
    diagnosticsSplitCandidates: string[];
    expensiveDiagnosticsMustBeCachedOrSplit: boolean;
  };
  noLiveProof: {
    fixtureOnly: boolean;
    liveBrokerHealthCalls: boolean;
    brokerRestart: boolean;
    gatewayRestart: boolean;
    liveProviderSend: boolean;
    terminalAck: "not_attempted";
    productionDbMutation: boolean;
    secretOrVisibilityChange: boolean;
    providerSendIsReceiptEvidence: boolean;
    allowedEvidence: string[];
  };
  operatorChecklist: string[];
}

function loadFixture(): BrokerHealthReadinessFixture {
  const raw = readFileSync(
    join(__dirname, "..", "examples", "broker-health-readiness-fixture.json"),
    "utf8",
  );
  return JSON.parse(raw) as BrokerHealthReadinessFixture;
}

test("broker health readiness fixture parses and stays tied to the health-readiness run", () => {
  const fixture = loadFixture();

  assert.match(fixture.description, /CI-safe/i);
  assert.equal(fixture.source.issue, "https://github.com/jinwon-int/a2a-docker-runner/issues/166");
  assert.equal(fixture.source.parent, "https://github.com/jinwon-int/a2a-plane/issues/181");
  assert.equal(fixture.source.rootHealthIssue, "https://github.com/jinwon-int/a2a-broker/issues/463");
  assert.equal(fixture.source.runId, "a2a-post-78261-health-readiness-20260510T024701Z");
});

test("broker health readiness fixture converts to a safe comment-only RunnerTask", () => {
  const fixture = loadFixture();
  const runnerTask = buildRunnerTaskFromHandlerPayload(fixture.handlerTask, {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
  });

  assert.equal(runnerTask.mode, "github-propose-patch");
  assert.equal(runnerTask.repo, "jinwon-int/a2a-docker-runner");
  assert.equal(runnerTask.baseBranch, "main");
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/166");
  assert.equal(runnerTask.forbidNewPr, true);
  assert.equal(runnerTask.commentOnly, true);
  assert.equal(runnerTask.runId, fixture.source.runId);
  assert.equal(runnerTask.requestedBy, "gwakga-jingun");
  assert.match(runnerTask.prompt ?? "", /Do not call live broker \/health/i);
});

test("broker health readiness fixture requires repeated-latency diagnostics and p99 gate", () => {
  const fixture = loadFixture();
  const plan = fixture.probePlan;

  assert.equal(plan.endpoint, "/health");
  assert.equal(plan.method, "GET");
  assert.equal(plan.sampleSize, 100);
  assert.ok(plan.latencyThresholdsMs.p95 <= 500, "p95 gate must stay at or below 500ms");
  assert.ok(plan.latencyThresholdsMs.p99 <= 500, "p99 gate must stay at or below 500ms");

  for (const expectedStage of [
    "persistenceSummary",
    "hotEntityMirrorCounts",
    "auditDiagnostics",
    "requestPressure",
    "jsonSerialization",
  ]) {
    assert.ok(
      plan.repeatedLatencyDiagnostics.includes(expectedStage),
      `missing repeated-latency diagnostic stage: ${expectedStage}`,
    );
  }

  assert.equal(plan.smallDbFixture.syntheticOnly, true);
  assert.equal(plan.smallDbFixture.tables.broker_tasks, 583);
  assert.equal(plan.smallDbFixture.tables.broker_audit_events, 1623);
  assert.equal(plan.smallDbFixture.tables.broker_terminal_outbox, 314);
  assert.ok(plan.diagnosticsSplitCandidates.includes("/health/diagnostics"));
  assert.equal(plan.expensiveDiagnosticsMustBeCachedOrSplit, true);
});

test("broker health readiness fixture carries explicit no-live/no-ACK proof", () => {
  const fixture = loadFixture();
  const proof = fixture.noLiveProof;

  assert.equal(proof.fixtureOnly, true);
  assert.equal(proof.liveBrokerHealthCalls, false);
  assert.equal(proof.brokerRestart, false);
  assert.equal(proof.gatewayRestart, false);
  assert.equal(proof.liveProviderSend, false);
  assert.equal(proof.terminalAck, "not_attempted");
  assert.equal(proof.productionDbMutation, false);
  assert.equal(proof.secretOrVisibilityChange, false);
  assert.equal(proof.providerSendIsReceiptEvidence, false);
  assert.deepEqual(proof.allowedEvidence, ["synthetic-fixture-json", "node-test-output", "git-diff"]);

  const checklist = fixture.operatorChecklist.join("\n");
  assert.match(checklist, /do not call a live broker endpoint/i);
  assert.match(checklist, /provider accepted-send is not terminal ACK/i);
});

test("broker health readiness fixture does not contain secrets, private paths, or OpenClaw bootstrap files", () => {
  const raw = readFileSync(
    join(__dirname, "..", "examples", "broker-health-readiness-fixture.json"),
    "utf8",
  );

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
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
    ".openclaw/",
  ]) {
    assert.ok(!raw.includes(forbidden), `fixture contains forbidden value: ${forbidden}`);
  }
});
