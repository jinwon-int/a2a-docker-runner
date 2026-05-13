import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunnerTaskFromHandlerPayload } from "./integration.js";
import { normalizeTask } from "./task-normalizer.js";
import type { HandlerEnv, HandlerTask } from "./integration.js";

interface ReadOnlyValidationFixture {
  schemaVersion: "a2a.runner.readonly-validation-stress-fixtures.v1";
  run: string;
  issueUrl: string;
  parentUrl: string;
  purpose: string;
  safetyState: {
    noProductionDeployOrRestart: true;
    noGatewayBrokerWorkerRestart: true;
    noLiveProviderSend: true;
    noTerminalAckReplay: true;
    noProductionDbMutation: true;
    terminalAck: "requires_operator_receipt";
    providerSendIsReceiptEvidence: false;
  };
  expectedGuards: {
    readOnlyBlockMarker: string;
    readOnlyPassMarker: string;
    noChangeDoneMarker: string;
    forbiddenPrMarker: string;
    bootstrapBlockMarker: string;
  };
  cases: ReadOnlyValidationCase[];
}

interface ReadOnlyValidationCase {
  name: string;
  task: HandlerTask;
  expected: {
    mode: string;
    readOnlyValidation: boolean;
    allowNoChanges: boolean;
    forbidNewPr: boolean;
    commentOnly: boolean;
    mustContain: string[];
    mustNotContain?: string[];
    mustOrderBefore: [string, string][];
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = resolve(__dirname, "..", "examples", "runner-readonly-validation-stress-fixtures.json");
const baseEnv: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1" };

function loadFixture(): { raw: string; fixture: ReadOnlyValidationFixture } {
  const raw = readFileSync(fixturePath, "utf8");
  return { raw, fixture: JSON.parse(raw) as ReadOnlyValidationFixture };
}

test("read-only validation stress fixture is scoped and carries safety gates", () => {
  const { raw, fixture } = loadFixture();

  assert.equal(fixture.schemaVersion, "a2a.runner.readonly-validation-stress-fixtures.v1");
  assert.equal(fixture.run, "a2a-stability-r7-20260513T101831Z");
  assert.equal(fixture.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/238");
  assert.equal(fixture.parentUrl, "https://github.com/jinwon-int/a2a-broker/issues/548");
  assert.deepEqual(fixture.safetyState, {
    noProductionDeployOrRestart: true,
    noGatewayBrokerWorkerRestart: true,
    noLiveProviderSend: true,
    noTerminalAckReplay: true,
    noProductionDbMutation: true,
    terminalAck: "requires_operator_receipt",
    providerSendIsReceiptEvidence: false,
  });
  assert.ok(fixture.cases.length >= 3, "fixture should cover explicit, alias, and github-verify lanes");

  assert.doesNotMatch(
    raw,
    /(?:^|["/\\])(?:AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY)\.md(?:["\s,}]|$)|(?:^|["/\\])\.openclaw(?:["/\\]|$)/m,
    "fixture must not include OpenClaw runtime/bootstrap context paths",
  );
});

test("read-only validation stress fixture matches broker-to-runner parity", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    const runnerTask = buildRunnerTaskFromHandlerPayload(entry.task, baseEnv);
    const normalized = normalizeTask(runnerTask);
    const pipeline = normalized.commands[1] ?? "";

    assert.equal(normalized.mode, entry.expected.mode, entry.name);
    assert.equal(normalized.readOnlyValidation, entry.expected.readOnlyValidation, entry.name);
    assert.equal(normalized.allowNoChanges, entry.expected.allowNoChanges, entry.name);
    assert.equal(normalized.forbidNewPr, entry.expected.forbidNewPr, entry.name);
    assert.equal(normalized.commentOnly, entry.expected.commentOnly, entry.name);

    for (const expected of entry.expected.mustContain) {
      assert.ok(pipeline.includes(expected), `${entry.name}: missing ${expected}`);
    }
    for (const forbidden of entry.expected.mustNotContain ?? []) {
      assert.ok(!pipeline.includes(forbidden), `${entry.name}: unexpected ${forbidden}`);
    }
    for (const [before, after] of entry.expected.mustOrderBefore) {
      const beforeIdx = pipeline.indexOf(before);
      const afterIdx = pipeline.indexOf(after);
      assert.ok(beforeIdx >= 0, `${entry.name}: missing ordered marker ${before}`);
      assert.ok(afterIdx >= 0, `${entry.name}: missing ordered marker ${after}`);
      assert.ok(beforeIdx < afterIdx, `${entry.name}: expected ${before} before ${after}`);
    }
  }
});
