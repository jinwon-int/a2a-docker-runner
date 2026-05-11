import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG_SCRIPT = join(__dirname, "..", "scripts", "tag-release-candidate.mjs");

// ═══════════════════════════════════════════════════════════════════════════
// Argument parsing and validation
// ═══════════════════════════════════════════════════════════════════════════

test("tag-release-candidate exits 2 on missing --version", () => {
  const result = spawnSync(process.execPath, [TAG_SCRIPT], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 2);
});

test("tag-release-candidate exits 2 on unknown argument", () => {
  const result = spawnSync(process.execPath, [TAG_SCRIPT, "--unknown"], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 2);
});

test("tag-release-candidate --help exits 0", () => {
  const result = spawnSync(process.execPath, [TAG_SCRIPT, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("--version"));
});

test("tag-release-candidate rejects invalid semver", () => {
  const result = spawnSync(
    process.execPath,
    [TAG_SCRIPT, "--version", "not.a.version", "--dry-run"],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );

  assert.notEqual(result.status, 0, `Expected non-zero exit for invalid semver`);
  assert.ok(
    result.stderr.includes("invalid semver") || result.stderr.includes("Error"),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Dry-run gate evidence output
// ═══════════════════════════════════════════════════════════════════════════

test("tag-release-candidate --dry-run produces valid gate evidence JSON", () => {
  const result = spawnSync(
    process.execPath,
    [TAG_SCRIPT, "--version", "0.1.0", "--dry-run"],
    {
      encoding: "utf8",
      timeout: 120_000,
      cwd: join(__dirname, ".."),
    },
  );

  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, "a2a.runner.tag-release-candidate.v1");
  assert.equal(output.parent, "a2a-docker-runner#195");
  assert.equal(output.version, "0.1.0");
  assert.equal(output.dryRun, true);
  assert.ok(output.tagName.startsWith("v0.1.0-rc"), `Expected tagName to start with v0.1.0-rc, got: ${output.tagName}`);
  assert.ok(Array.isArray(output.gates), "output.gates must be an array");
  assert.ok(output.gates.length >= 2, `Expected at least 2 gates, got ${output.gates.length}`);

  const gateNames = output.gates.map((g: { name: string }) => g.name);
  assert.ok(gateNames.includes("clean-tree"));
  assert.ok(gateNames.includes("bootstrap-guard"));
  assert.ok(gateNames.includes("pkg-version"));

  // tagCreated is only present when gates pass (dry-run or real).
  // In workspaces with OpenClaw bootstrap files on disk, the bootstrap-guard
  // gate fails correctly and tagCreated is absent.
  if (output.tagCreated !== undefined) {
    assert.equal(output.tagCreated, false);
  }
  // ok: true means all gates passed; false means at least one gate failed.
  assert.equal(typeof output.ok, "boolean");
});

test("tag-release-candidate dry-run output never leaks host paths", () => {
  const result = spawnSync(
    process.execPath,
    [TAG_SCRIPT, "--version", "0.1.0", "--dry-run"],
    {
      encoding: "utf8",
      timeout: 120_000,
      cwd: join(__dirname, ".."),
    },
  );

  // Sanity: output must be parseable JSON with no raw filesystem paths.
  JSON.parse(result.stdout);
  assert.ok(!result.stdout.includes("/home/"), "output must not contain /home/ paths");
  assert.ok(!result.stdout.includes("/root/"), "output must not contain /root/ paths");
});

test("tag-release-candidate with --message produces valid gate evidence JSON", () => {
  const result = spawnSync(
    process.execPath,
    [TAG_SCRIPT, "--version", "0.1.0", "--dry-run", "--message", "Round 5 smoke pass"],
    {
      encoding: "utf8",
      timeout: 120_000,
      cwd: join(__dirname, ".."),
    },
  );

  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.equal(typeof output.ok, "boolean");
  assert.equal(output.schemaVersion, "a2a.runner.tag-release-candidate.v1");
  assert.equal(output.version, "0.1.0");
});
