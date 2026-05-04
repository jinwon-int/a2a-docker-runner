import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildArtifactManifest, buildResultSummary, redactAndBound, RESULT_STREAM_LIMIT } from "./runner.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("buildArtifactManifest returns deterministic schema sorted by relative path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-manifest-"));
  try {
    const artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const b = join(artifactsDir, "b.log");
    const a = join(artifactsDir, "a.txt");
    await writeFile(b, "bbbb");
    await writeFile(a, "aa");

    const manifest = await buildArtifactManifest(dir, [b, a]);

    assert.equal(manifest.artifactVersion, 1);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(manifest.manifestPath, "artifacts/manifest.json");
    assert.equal(manifest.status, "done");
    assert.ok(manifest.summary.length > 0);
    assert.deepEqual(manifest.artifacts.map((entry) => entry.path), ["artifacts/a.txt", "artifacts/b.log"]);
    assert.deepEqual(manifest.artifacts.map((entry) => entry.sizeBytes), [2, 4]);
    assert.deepEqual(manifest.evidence.map((entry) => entry.label), ["a.txt", "b.log"]);
    assert.equal(manifest.evidence[0].kind, "log");
    assert.equal(manifest.evidence[0].excerpt, "aa");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildArtifactManifest supports executions with no task artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-no-artifacts-"));
  try {
    const manifest = await buildArtifactManifest(dir, []);
    assert.equal(manifest.artifactVersion, 1);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.summary, "Runner done with 0 evidence parts.");
    assert.deepEqual(manifest.evidence, []);
    assert.deepEqual(manifest.artifacts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redactAndBound redacts secret-like values and truncates large output", () => {
  const syntheticSecret = "github" + "_pat" + "_" + "A".repeat(90);
  const output = `token=${syntheticSecret}\npassword=plain-text\n${"x".repeat(RESULT_STREAM_LIMIT + 50)}`;

  const bounded = redactAndBound(output);

  assert.ok(!bounded.includes(syntheticSecret));
  assert.ok(!bounded.includes("password=plain-text"));
  assert.ok(bounded.includes("token=<redacted>") || bounded.includes("<redacted-github-token>"));
  assert.ok(bounded.includes("password=<redacted>"));
  assert.ok(bounded.length < output.length);
  assert.match(bounded, /<truncated \d+ chars>/);
});

test("buildResultSummary is bounded payload-compatible while RunnerResult fields remain additive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-summary-"));
  try {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    const artifact = join(dir, "artifacts", "summary.txt");
    await writeFile(artifact, "ok");
    const manifest = await buildArtifactManifest(dir, [artifact]);
    const stdout = redactAndBound("ok");
    const stderr = redactAndBound("secret=synthetic-value");

    const summary = buildResultSummary(
      { code: 0, signal: null, stdout: "ok", stderr: "", timedOut: false },
      stdout,
      stderr,
      [artifact],
      manifest,
    );

    assert.equal(summary.exitCode, 0);
    assert.equal(summary.timedOut, false);
    assert.equal(summary.artifactCount, 1);
    assert.equal(summary.manifestPath, manifest.manifestPath);
    assert.equal(summary.stderr, "secret=<redacted>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("buildArtifactManifest and resultSummary preserve budget-limited continuation evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-budget-manifest-"));
  try {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    const artifact = join(dir, "artifacts", "summary.txt");
    await writeFile(artifact, "status=budget_limited\nbudget.limitKind=time\nbudget.reason=time budget exhausted");
    const budget = { limitKind: "time" as const, limit: "45m", used: "45m", reason: "time budget exhausted" };
    const continuation = { recommended: true, requiresApproval: true as const, nextPrompt: "continue after approval" };
    const manifest = await buildArtifactManifest(dir, [artifact], {
      status: "budget_limited",
      stdout: "status=budget_limited",
      budget,
      continuation,
    });
    const summary = buildResultSummary(
      { code: 0, signal: null, stdout: "status=budget_limited", stderr: "", timedOut: false },
      redactAndBound("status=budget_limited"),
      "",
      [artifact],
      manifest,
    );

    assert.equal(manifest.status, "budget_limited");
    assert.deepEqual(manifest.budget, budget);
    assert.deepEqual(manifest.continuation, continuation);
    assert.equal(summary.status, "budget_limited");
    assert.deepEqual(summary.budget, budget);
    assert.deepEqual(summary.continuation, continuation);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("artifact manifest schema and dummy sample stay aligned", async () => {
  const schema = JSON.parse(await readFile(join(repoRoot, "docs", "artifact-manifest.schema.json"), "utf8"));
  const sample = JSON.parse(await readFile(join(repoRoot, "examples", "artifact-manifest.dummy-task.json"), "utf8"));

  for (const field of schema.required) {
    assert.ok(Object.hasOwn(sample, field), `sample includes required field ${field}`);
  }
  assert.equal(sample.artifactVersion, 1);
  assert.equal(sample.schemaVersion, 1);
  assert.equal(sample.manifestPath, "artifacts/manifest.json");
  assert.match(sample.status, /^(done|blocked|failed|budget_limited)$/);
  assert.ok(sample.summary.length > 0);
  assert.ok(sample.evidence.length > 0);
  for (const part of sample.evidence) {
    assert.match(part.kind, /^(log|test|diff|file)$/);
    assert.ok(part.label.length > 0);
  }
});
