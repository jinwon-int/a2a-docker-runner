import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = "scripts/rollout-receipt-evidence-guard.mjs";
const EXPECTED_COMMIT = "123df9b19e2c600e826273f5b16117039aa44b6f";
const WORKERS = ["bangtong", "dungae", "sogyo", "nosuk"];
const NO_LIVE_FIXTURE = "examples/rollout-receipt-evidence.no-live.json";

function fixtureFor(worker: string) {
  return {
    worker,
    runnerBuild: { version: "0.1.0", revision: EXPECTED_COMMIT },
    focusedTest: { name: "npm run smoke:telegram-terminal-ack", status: "passed" },
    terminalReceiptSmoke: {
      operatorVisible: true,
      receiptId: `synthetic-${worker}-receipt`,
      providerSendOnly: { acknowledged: false, cursorComplete: false },
    },
    staleBacklog: { count: 0 },
  };
}

function writeFixture(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-rollout-guard-"));
  const file = join(dir, "merged-evidence.json");
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function runGuard(input: string, expectedCommit = EXPECTED_COMMIT) {
  return execFileSync(process.execPath, [SCRIPT, "--input", input, "--expected-commit", expectedCommit], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
}

test("rollout receipt evidence guard accepts complete active-worker evidence", () => {
  const input = writeFixture({ workers: WORKERS.map(fixtureFor) });
  const output = JSON.parse(runGuard(input)) as { ok: boolean; workers: Array<{ ok: boolean }> };

  assert.equal(output.ok, true);
  assert.equal(output.workers.length, 4);
  assert.ok(output.workers.every((worker) => worker.ok));
});

test("no-live proof bundle fixture passes the rollout evidence guard", () => {
  const raw = readFileSync(new URL(`../${NO_LIVE_FIXTURE}`, import.meta.url), "utf8");
  const fixture = JSON.parse(raw) as { workers: Array<{ runnerBuild: { revision: string } }> };
  const expectedCommit = fixture.workers[0]?.runnerBuild.revision;

  assert.ok(expectedCommit);
  assert.ok(fixture.workers.every((worker) => worker.runnerBuild.revision === expectedCommit));

  const output = JSON.parse(runGuard(NO_LIVE_FIXTURE, expectedCommit)) as { ok: boolean; workers: Array<{ ok: boolean }> };

  assert.equal(output.ok, true);
  assert.equal(output.workers.length, 4);
  assert.ok(output.workers.every((worker) => worker.ok));
});

test("rollout receipt evidence guard fails closed on missing worker evidence", () => {
  const input = writeFixture({ workers: WORKERS.filter((worker) => worker !== "nosuk").map(fixtureFor) });

  assert.throws(
    () => runGuard(input),
    (error: unknown) => {
      const stderr = error as { stdout?: Buffer | string; status?: number };
      const output = JSON.parse(String(stderr.stdout)) as { ok: boolean; workers: Array<{ worker: string; errors: string[] }> };
      const nosuk = output.workers.find((worker) => worker.worker === "nosuk");
      assert.equal(stderr.status, 1);
      assert.equal(output.ok, false);
      assert.deepEqual(nosuk?.errors, ["missing worker evidence"]);
      return true;
    },
  );
});

test("rollout receipt evidence guard rejects mismatched commits and provider-send-only ACK", () => {
  const workers = WORKERS.map(fixtureFor);
  workers[0].runnerBuild.revision = "bad-commit";
  workers[1].terminalReceiptSmoke.providerSendOnly.acknowledged = true;
  const input = writeFixture({ workers });

  assert.throws(
    () => runGuard(input),
    (error: unknown) => {
      const failed = JSON.parse(String((error as { stdout?: Buffer | string }).stdout)) as { workers: Array<{ worker: string; errors: string[] }> };
      assert.match(failed.workers.find((worker) => worker.worker === "bangtong")?.errors.join("\n") ?? "", /does not match expected/);
      assert.match(failed.workers.find((worker) => worker.worker === "dungae")?.errors.join("\n") ?? "", /provider-send-only ACK/);
      return true;
    },
  );
});
