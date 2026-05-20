/**
 * No-live auto-closeout fixture harness tests (Team1 source-only lane).
 *
 * Validates the CI-safe auto-closeout fixture data without enabling production
 * auto-closeout, broker round closeout, Gateway restart, provider send,
 * terminal ACK, DB mutation, PR merge, or secret disclosure.
 *
 * Safety gate: source-only. Production auto-closeout is never enabled.
 *
 * Parent: a2a-docker-runner#299
 * Parent: a2a-broker#832
 * Run: a2a-team1-auto-closeout-design-20260520T113050Z
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildHandlerResult, buildRunnerTaskFromHandlerPayload } from "./integration.js";
import type { HandlerTask, HandlerResult, RawRunnerOutput, TerminalEvidenceKind, TerminalEvidenceStatus } from "./integration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface AutoCloseoutCase {
  name: string;
  handlerTask: HandlerTask;
  runnerOutput: RawRunnerOutput;
  expected: {
    evidenceKind: TerminalEvidenceKind;
    status: TerminalEvidenceStatus;
    noLiveAutoCloseout: true;
    autoCloseoutEnabled: false;
    allNodesComplete?: boolean;
    parentRoundTotal?: number;
    parentRoundProgress?: number;
  };
}

interface AutoCloseoutFixture {
  $schema: string;
  description: string;
  run: string;
  parentRoundId: string;
  issue: string;
  parent: string;
  parentRoundTotal: number;
  parentRoundOrder: number;
  parentRoundProgress: number;
  originBrokerId: string;
  brokerOfRecordId: string;
  parentBrokerId: string;
  noLiveProof: {
    fixtureOnly: boolean;
    autoCloseoutEnabled: false;
    liveAutoCloseoutExecution: false;
    liveBrokerRoundCloseout: false;
    brokerRestart: false;
    gatewayRestart: false;
    workerRestart: false;
    liveProviderSend: false;
    terminalAck: "not_attempted";
    productionDbMutation: false;
    secretOrVisibilityChange: false;
    providerSendIsReceiptEvidence: false;
    prMergeAutomation: false;
    releasePublish: false;
    credentialMovement: false;
    allowedEvidence: string[];
  };
  canonicalCloseout: {
    allowedEvidenceKinds: TerminalEvidenceKind[];
    terminalAckRequiresOperatorVisibleReceipt: true;
    providerSendSuccessIsReceiptEvidence: false;
    noLiveProviderSend: true;
    terminalOutboxAckPerformed: false;
    autoCloseoutMode: "source_only";
  };
  activeNodes: string[];
  source: {
    schemaVersion: string;
    parentRoundTotal: number;
    parentRoundOrder: number;
    parentRoundProgress: number;
    originBrokerId: string;
    brokerOfRecordId: string;
    parentBrokerId: string;
  };
  cases: AutoCloseoutCase[];
}

const fixturePath = resolve(__dirname, "..", "examples", "auto-closeout-fixture.json");

function loadFixture(): AutoCloseoutFixture {
  const raw = readFileSync(fixturePath, "utf8");
  return JSON.parse(raw) as AutoCloseoutFixture;
}

/**
 * Assert that a fixture's raw text is free of secrets, host private paths,
 * and OpenClaw bootstrap context files.
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

test("auto-closeout fixture parses and matches the Team1 source-only design run", () => {
  const fixture = loadFixture();

  assert.match(fixture.description, /no-live auto-closeout/i);
  assert.equal(fixture.run, "a2a-team1-auto-closeout-design-20260520T113050Z");
  assert.equal(fixture.issue, "https://github.com/jinwon-int/a2a-docker-runner/issues/299");
  assert.equal(fixture.parent, "https://github.com/jinwon-int/a2a-broker/issues/832");
  assert.equal(fixture.parentRoundTotal, 4);
  assert.equal(fixture.parentRoundOrder, 1);
  assert.equal(fixture.parentRoundProgress, 0);
  assert.equal(fixture.originBrokerId, "seoseo");
  assert.equal(fixture.brokerOfRecordId, "seoseo");
  assert.equal(fixture.parentBrokerId, "seoseo");
});

test("auto-closeout fixture enforces no-live safety proof; production auto-closeout is never enabled", () => {
  const fixture = loadFixture();
  const proof = fixture.noLiveProof;

  assert.equal(proof.fixtureOnly, true);
  assert.equal(proof.autoCloseoutEnabled, false);
  assert.equal(proof.liveAutoCloseoutExecution, false);
  assert.equal(proof.liveBrokerRoundCloseout, false);
  assert.equal(proof.brokerRestart, false);
  assert.equal(proof.gatewayRestart, false);
  assert.equal(proof.workerRestart, false);
  assert.equal(proof.liveProviderSend, false);
  assert.equal(proof.terminalAck, "not_attempted");
  assert.equal(proof.productionDbMutation, false);
  assert.equal(proof.secretOrVisibilityChange, false);
  assert.equal(proof.providerSendIsReceiptEvidence, false);
  assert.equal(proof.prMergeAutomation, false);
  assert.equal(proof.releasePublish, false);
  assert.equal(proof.credentialMovement, false);
  assert.deepEqual(proof.allowedEvidence, ["synthetic-fixture-json", "node-test-output", "git-diff"]);
});

test("auto-closeout fixture canonical closeout mode is source_only with no-live terminal ack rules", () => {
  const fixture = loadFixture();
  const closeout = fixture.canonicalCloseout;

  assert.equal(closeout.autoCloseoutMode, "source_only");
  assert.equal(closeout.terminalAckRequiresOperatorVisibleReceipt, true);
  assert.equal(closeout.providerSendSuccessIsReceiptEvidence, false);
  assert.equal(closeout.noLiveProviderSend, true);
  assert.equal(closeout.terminalOutboxAckPerformed, false);
  assert.deepEqual(closeout.allowedEvidenceKinds, ["PR", "Done", "Block"]);
});

test("auto-closeout fixture source metadata matches the assignment round context", () => {
  const fixture = loadFixture();
  const source = fixture.source;

  assert.equal(source.schemaVersion, "a2a.runner.auto-closeout-fixture.v1");
  assert.equal(source.parentRoundTotal, 4);
  assert.equal(source.parentRoundOrder, 1);
  assert.equal(source.parentRoundProgress, 0);
  assert.equal(source.originBrokerId, "seoseo");
  assert.equal(source.brokerOfRecordId, "seoseo");
  assert.equal(source.parentBrokerId, "seoseo");
});

test("auto-closeout fixture covers PR, Done, and Block evidence kinds", () => {
  const fixture = loadFixture();
  const observedKinds = new Set<TerminalEvidenceKind>();

  for (const entry of fixture.cases) {
    const handlerResult = buildHandlerResult(
      entry.runnerOutput,
      entry.handlerTask,
      "seoseo",
    );
    const terminalEvidence = handlerResult.terminalEvidence;

    observedKinds.add(terminalEvidence.evidenceKind);

    assert.equal(terminalEvidence.status, entry.expected.status, entry.name);
    assert.equal(terminalEvidence.evidenceKind, entry.expected.evidenceKind, entry.name);
    assert.equal(terminalEvidence.safetyState.noLiveProviderSend, true, entry.name);
    assert.equal(terminalEvidence.safetyState.terminalAck, "requires_operator_receipt", entry.name);
    assert.equal(terminalEvidence.safetyState.providerSendIsReceiptEvidence, false, entry.name);

    // Production auto-closeout must never be enabled.
    assert.equal(entry.expected.noLiveAutoCloseout, true, `noLiveAutoCloseout: ${entry.name}`);
    assert.equal(entry.expected.autoCloseoutEnabled, false, `autoCloseoutEnabled must be false: ${entry.name}`);

    // Verify parent-round metadata is preserved in terminal brief context when provided.
    const tb = terminalEvidence.terminalBrief;
    if (entry.handlerTask.payload?.parentRoundId) {
      assert.ok(tb, `terminalBrief must be present for round-aware task: ${entry.name}`);
      assert.equal(tb.parentRoundId, "a2a-team1-auto-closeout-design-20260520T113050Z", entry.name);
    }

    // Verify comment-only results in Done evidence, not PR.
    if (entry.handlerTask.payload?.commentOnly) {
      assert.equal(terminalEvidence.evidenceKind, "Done", entry.name);
    }

    // Verify PR evidence carries the prUrl.
    if (entry.expected.evidenceKind === "PR") {
      assert.ok(handlerResult.prUrl, `prUrl must be present: ${entry.name}`);
      assert.ok(terminalEvidence.prUrl, `terminalEvidence.prUrl must be present: ${entry.name}`);
    }

    // Verify Block evidence carries the blockCommentUrl.
    if (entry.expected.evidenceKind === "Block") {
      assert.ok(handlerResult.blockCommentUrl, `blockCommentUrl must be present: ${entry.name}`);
      assert.ok(terminalEvidence.blockUrl, `terminalEvidence.blockUrl must be present: ${entry.name}`);
    }

    // Verify Done evidence carries the doneCommentUrl.
    if (entry.expected.evidenceKind === "Done") {
      assert.ok(handlerResult.doneCommentUrl, `doneCommentUrl must be present: ${entry.name}`);
      assert.ok(terminalEvidence.doneUrl, `terminalEvidence.doneUrl must be present: ${entry.name}`);
    }

    // Verify handlerResult.status matches the expected evidence kind.
    // PR -> pr_opened, Done -> done, Block -> blocked.
    if (entry.expected.evidenceKind === "PR") {
      assert.equal(handlerResult.status, "pr_opened", entry.name);
    } else if (entry.expected.evidenceKind === "Done") {
      assert.equal(handlerResult.status, "done", entry.name);
    } else if (entry.expected.evidenceKind === "Block") {
      assert.equal(handlerResult.status, "blocked", entry.name);
    }
  }

  assert.deepEqual(
    [...observedKinds].sort(),
    ["Block", "Done", "PR"].sort(),
    "fixture must cover PR, Done, and Block evidence kinds",
  );
});

test("auto-closeout fixture does not contain secrets, private paths, or OpenClaw bootstrap files", () => {
  const raw = readFileSync(fixturePath, "utf8");
  assertNoBootstrapLeaks(raw);
});

test("auto-closeout fixture cases are all safe for CI: no live broker, provider, or auto-closeout calls", () => {
  const fixture = loadFixture();

  for (const entry of fixture.cases) {
    // Verify no live auto-closeout in the runner output or task.
    const serialized = JSON.stringify(entry.runnerOutput) + JSON.stringify(entry.handlerTask);

    for (const forbidden of [
      "autoCloseoutEnabled=true",
      "liveAutoCloseoutExecution",
      "auto-closeout-execution",
      "productionAutoCloseout",
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `case "${entry.name}" must not reference live auto-closeout: ${forbidden}`,
      );
    }
  }
});

test("auto-closeout fixture handler task converts to safe comment-only RunnerTask when configured", () => {
  const fixture = loadFixture();
  const doneCase = fixture.cases.find((c) => c.handlerTask.payload?.commentOnly);
  assert.ok(doneCase, "fixture must include a comment-only done case");

  const runnerTask = buildRunnerTaskFromHandlerPayload(doneCase!.handlerTask, {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
  });

  assert.equal(runnerTask.mode, "github-propose-patch");
  assert.equal(runnerTask.repo, "jinwon-int/a2a-docker-runner");
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/299");
  assert.equal(runnerTask.commentOnly, true);
  assert.equal(runnerTask.id, "auto-closeout-r1-done-4");
  assert.match(runnerTask.issueTitle ?? "", /auto-closeout/);
});
