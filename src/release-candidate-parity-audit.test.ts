import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const AUDIT_SCRIPT = join(import.meta.dirname ?? ".", "..", "scripts", "release-candidate-parity-audit.mjs");

test("release candidate parity audit passes with public-safe evidence", () => {
  const result = spawnSync(process.execPath, [AUDIT_SCRIPT], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr || result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, "a2a.runner.release-candidate-parity-audit.v1");
  assert.equal(output.ok, true);
  assert.equal(output.sourcePublicExecution, "not_performed");
  assert.equal(output.liveProviderSendPerformed, false);
  assert.equal(output.terminalAckSent, false);
  assert.equal(output.dbMutationPerformed, false);
  assert.equal(output.deployOrRestartPerformed, false);
  assert.deepEqual(output.activeWorkers, ["bangtong", "dungae", "sogyo", "nosuk"]);
  assert.deepEqual(output.excludedWorkers, ["yukson"]);
  for (const path of ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "IDENTITY.md", ".openclaw", "memory"]) {
    assert.ok(output.bootstrapGuardBannedPaths.includes(path), `missing bootstrap guard path ${path}`);
  }
  assert.ok(output.checks.length > 0, "audit should emit individual parity checks");
  assert.deepEqual(output.failures, []);

  assert.ok(!result.stdout.includes("/work/"), "audit evidence must not include container workspace paths");
  assert.ok(!result.stdout.includes("/home/"), "audit evidence must not include home paths");
  assert.ok(!result.stdout.includes("/root/"), "audit evidence must not include root paths");
});
