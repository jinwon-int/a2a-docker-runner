import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHandlerResult,
  buildOperatorTaskReportEvidence,
  extractGitHubEvidence,
  parseRunnerOutput,
} from "./integration.js";
import type {
  HandlerResult,
  HandlerTask,
  RawRunnerOutput,
  TerminalEvidenceKind,
  TerminalEvidenceStatus,
} from "./integration.js";

interface RegressionFixture {
  schemaVersion: "a2a.runner.nochange-regression-fixtures.v1";
  run: string;
  issueUrl: string;
  coordinatesWith: string;
  safetyState: {
    noProductionDeployOrRestart: true;
    noLiveProviderSend: true;
    terminalAck: "requires_operator_receipt";
    providerSendIsReceiptEvidence: false;
  };
  cases: RegressionCase[];
}

interface RegressionCase {
  name: string;
  task: HandlerTask;
  runnerOutput: RawRunnerOutput;
  expected: {
    handlerStatus: HandlerResult["status"];
    evidenceKind: TerminalEvidenceKind;
    terminalStatus: TerminalEvidenceStatus;
    prUrl?: string;
    doneCommentUrl?: string;
    blockCommentUrl?: string;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = resolve(__dirname, "..", "examples", "runner-evidence-nochange-regression-fixtures.json");

function loadFixture(): RegressionFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as RegressionFixture;
}

test("no-change hardening fixture is scoped and does not carry OpenClaw bootstrap context", () => {
  const raw = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(raw) as RegressionFixture;

  assert.equal(fixture.schemaVersion, "a2a.runner.nochange-regression-fixtures.v1");
  assert.equal(fixture.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/170");
  assert.equal(fixture.coordinatesWith, "https://github.com/jinwon-int/a2a-docker-runner/issues/169");
  assert.deepEqual(fixture.safetyState, {
    noProductionDeployOrRestart: true,
    noLiveProviderSend: true,
    terminalAck: "requires_operator_receipt",
    providerSendIsReceiptEvidence: false,
  });
  assert.equal(fixture.cases.length, 4);

  assert.doesNotMatch(
    raw,
    /(?:^|["/\\])(?:AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY)\.md(?:["\s,}]|$)|(?:^|["/\\])\.openclaw(?:["/\\]|$)/m,
    "fixture must not include OpenClaw runtime/bootstrap context paths",
  );
});

test("no-change hardening fixture covers Done, Block, infrastructure failure, and PR success", () => {
  const fixture = loadFixture();
  const seenKinds = new Set<TerminalEvidenceKind>();

  for (const entry of fixture.cases) {
    const parsed = parseRunnerOutput(JSON.stringify(entry.runnerOutput));
    const evidence = extractGitHubEvidence(parsed);
    const handlerResult = buildHandlerResult(parsed, entry.task, "jingun");
    const operatorReport = buildOperatorTaskReportEvidence(handlerResult);

    seenKinds.add(handlerResult.terminalEvidence.evidenceKind);
    assert.equal(handlerResult.status, entry.expected.handlerStatus, entry.name);
    assert.equal(handlerResult.terminalEvidence.evidenceKind, entry.expected.evidenceKind, entry.name);
    assert.equal(handlerResult.terminalEvidence.status, entry.expected.terminalStatus, entry.name);
    assert.deepEqual(handlerResult.terminalEvidence.safetyState, {
      noLiveProviderSend: true,
      terminalAck: "requires_operator_receipt",
      providerSendIsReceiptEvidence: false,
    });
    assert.equal(operatorReport.dedupeKey, handlerResult.terminalEvidence.dedupeKey);

    if (entry.expected.prUrl) {
      assert.equal(handlerResult.prUrl, entry.expected.prUrl, entry.name);
      assert.equal(evidence?.prUrl, entry.expected.prUrl, entry.name);
      assert.equal(handlerResult.doneCommentUrl, undefined, entry.name);
      assert.equal(handlerResult.blockCommentUrl, undefined, entry.name);
    }

    if (entry.expected.doneCommentUrl) {
      assert.equal(handlerResult.doneCommentUrl, entry.expected.doneCommentUrl, entry.name);
      assert.equal(evidence?.doneCommentUrl, entry.expected.doneCommentUrl, entry.name);
      assert.equal(handlerResult.prUrl, undefined, entry.name);
      assert.equal(handlerResult.blockCommentUrl, undefined, entry.name);
    }

    if (entry.expected.blockCommentUrl) {
      assert.equal(handlerResult.blockCommentUrl, entry.expected.blockCommentUrl, entry.name);
      assert.equal(evidence?.blockCommentUrl, entry.expected.blockCommentUrl, entry.name);
      assert.equal(handlerResult.prUrl, undefined, entry.name);
      assert.equal(handlerResult.doneCommentUrl, undefined, entry.name);
    }

    if (entry.expected.evidenceKind === "MissingEvidence") {
      assert.equal(evidence, null, entry.name);
      assert.equal(handlerResult.prUrl, undefined, entry.name);
      assert.equal(handlerResult.doneCommentUrl, undefined, entry.name);
      assert.equal(handlerResult.blockCommentUrl, undefined, entry.name);
      assert.match(handlerResult.terminalEvidence.reason ?? "", /container image pull\/start failed|Runner failed/, entry.name);
    }
  }

  assert.deepEqual(
    [...seenKinds].sort(),
    ["Block", "Done", "MissingEvidence", "PR"].sort(),
  );
});
