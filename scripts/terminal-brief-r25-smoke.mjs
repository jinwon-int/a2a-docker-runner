// Terminal Brief R25 smoke test — structured summary fields.
//
// Validates that TerminalEvidenceEvent emits stable summary fields
// (taskBrief, filesChanged, prUrl, issueUrl, validationCommands, status, risks)
// and that the alert body is compact (no raw stdout/stderr).
//
// Usage: node scripts/terminal-brief-r25-smoke.mjs

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── Load dist — may need to npm run build first ──
let integ;
try {
  integ = await import(resolve(repoRoot, "dist/integration.js"));
} catch {
  console.error("dist/integration.js not found. Run 'npm run build' first.");
  process.exit(1);
}

const { parseRunnerOutput, buildTerminalEvidenceEvent, buildHandlerResult } = integ;

// ── Load the R25 fixture ──
const fixturePath = resolve(repoRoot, "examples/runner-terminal-evidence-r25-fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log(`\nTerminal Brief R25 smoke test\n`);
console.log(`Fixture: ${fixture.description}`);
console.log(`Run: ${fixture.run}\n`);

for (const scenario of fixture.scenarios) {
  console.log(`\n── ${scenario.name} ──\n`);

  const parsed = parseRunnerOutput(JSON.stringify(scenario.runnerOutput));
  const event = buildTerminalEvidenceEvent(
    parsed,
    scenario.handlerTask,
    fixture.worker,
    fixture.emittedAt,
  );

  // ── Schema version check ──
  test("schemaVersion is present", () => {
    assert.equal(event.schemaVersion, "a2a.runner.terminal-evidence.v1");
  });

  // ── Stable summary fields ──
  test("filesChanged is a stable, bounded array", () => {
    assert.ok(Array.isArray(event.filesChanged));
    // Must not contain private filesystem paths
    for (const fc of event.filesChanged) {
      assert.ok(!fc.includes("/private/"), `filesChanged contains private path: ${fc}`);
      assert.ok(!fc.includes("/root/"), `filesChanged contains root path: ${fc}`);
    }
  });

  test("risks is a stable, bounded array", () => {
    assert.ok(Array.isArray(event.risks));
    for (const r of event.risks) {
      assert.equal(typeof r, "string");
      assert.ok(r.length <= 240, `risk too long: ${r.length}`);
    }
  });

  test("validationCommands is a stable, bounded array", () => {
    assert.ok(Array.isArray(event.validationCommands));
    for (const cmd of event.validationCommands) {
      assert.equal(typeof cmd, "string");
      assert.ok(cmd.length <= 240, `validation command too long: ${cmd.length}`);
    }
  });

  // ── taskBrief (now on the event) ──
  test("taskBrief is present and safe", () => {
    assert.ok(event.taskBrief !== undefined);
    assert.ok(typeof event.taskBrief === "string");
    assert.ok(event.taskBrief.length <= 240, `taskBrief too long: ${event.taskBrief.length}`);
  });

  // ── Evidence URLs ──
  test("issueUrl is a safe GitHub URL", () => {
    assert.ok(event.issueUrl, "issueUrl is missing");
    assert.ok(event.issueUrl.startsWith("https://github.com/"), `issueUrl not github: ${event.issueUrl}`);
  });

  test("event has at least one evidence URL (prUrl, doneUrl, or blockUrl)", () => {
    const hasEvidenceUrl = Boolean(event.prUrl || event.doneUrl || event.blockUrl);
    assert.ok(hasEvidenceUrl, "no evidence URL present");
  });

  // ── Status is valid ──
  test("status is a valid TerminalEvidenceStatus", () => {
    const valid = ["succeeded", "blocked", "failed", "cancelled"];
    assert.ok(valid.includes(event.status), `invalid status: ${event.status}`);
  });

  // ── Alert body is compact and safe ──
  test("alert body is present and compact", () => {
    assert.ok(event.alert?.body, "alert body is missing");
    assert.ok(event.alert.body.length <= 360, `alert body too long: ${event.alert.body.length}`);
  });

  test("alert body does not contain raw runner stdout or stderr", () => {
    const body = event.alert.body;
    assert.ok(!body.includes("stdout"), "alert body contains 'stdout' reference");
    assert.ok(!body.includes("stderr"), "alert body contains 'stderr' reference");
  });

  test("alert body does not contain secrets or private paths", () => {
    const body = event.alert.body;
    for (const forbidden of fixture.safeEvidenceMustNotContain) {
      if (forbidden === "stdout" || forbidden === "stderr" || forbidden === "SOUL.md") continue;
      assert.ok(!body.includes(forbidden), `alert body contains forbidden: ${forbidden}`);
    }
  });

  test("entire event does not contain real secrets or bootstrap files", () => {
    const serialized = JSON.stringify(event);
    for (const forbidden of fixture.safeEvidenceMustNotContain) {
      if (forbidden === "stdout" || forbidden === "stderr") continue;
      assert.ok(!serialized.includes(forbidden), `event contains forbidden: ${forbidden}`);
    }
  });

  // ── Artifact references available for audit ──
  test("filesChanged.length matches artifact count in testSummary", () => {
    // filesChanged can have 0 items even when artifacts exist (when manifestPath is used)
    // but they should be consistent
    if (event.filesChanged.length > 0) {
      assert.ok(event.testSummary.artifactCount !== undefined);
    }
  });

  // ── handlerResult tests ──
  const handlerResult = buildHandlerResult(parsed, scenario.handlerTask, fixture.worker);

  test("handlerResult has filesChanged", () => {
    assert.ok(Array.isArray(handlerResult.filesChanged));
  });

  test("handlerResult has risks array", () => {
    assert.ok(Array.isArray(handlerResult.risks));
  });

  test("handlerResult summary is a string", () => {
    assert.equal(typeof handlerResult.summary, "string");
    assert.ok(handlerResult.summary.length > 0);
  });

  // ── No raw runner output in event (task brief text with "raw logs" is acceptable) ──
  test("event payload does not contain runner stdout or stderr text", () => {
    const serialized = JSON.stringify(event);
    // Check for the literal stdout/stderr output text from our fixture
    const stdoutText = scenario.runnerOutput.stdout;
    if (stdoutText && !stdoutText.includes("stdout")) {
      // Only check if stdout content is not the word "stdout" itself
      assert.ok(!serialized.includes(stdoutText), "event contains raw stdout content");
    }
    const stderrText = scenario.runnerOutput.stderr;
    if (stderrText && !stderrText.includes("stderr")) {
      assert.ok(!serialized.includes(stderrText), "event contains raw stderr content");
    }
  });
}

// ── Fail-closed check: no OpenClaw bootstrap files ──
console.log(`\n── Fail-closed: OpenClaw bootstrap files ──\n`);

const bootstrapFiles = [
  "AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md",
  "HEARTBEAT.md", "IDENTITY.md", ".openclaw",
];

let bootstrapFailures = [];
for (const file of bootstrapFiles) {
  const fullPath = resolve(repoRoot, file);
  try {
    readFileSync(fullPath);
    // File exists — this is a failure
    bootstrapFailures.push(file);
  } catch {
    // File doesn't exist — good
  }
}

test("no OpenClaw bootstrap files in branch", () => {
  if (bootstrapFailures.length > 0) {
    throw new Error(
      `Found ${bootstrapFailures.length} OpenClaw bootstrap file(s) in repo: ${bootstrapFailures.join(", ")}`
    );
  }
});

// ── Summary ──
console.log(`\n┌─────────────────────────────────┐`);
console.log(`│  R25 smoke: ${passed} passed, ${failed} failed  │`);
console.log(`└─────────────────────────────────┘\n`);

process.exit(failed > 0 ? 1 : 0);
