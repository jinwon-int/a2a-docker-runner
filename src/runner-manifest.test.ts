import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildArtifactManifest, buildResultSummary, redactAndBound, RESULT_STREAM_LIMIT } from "./runner.js";

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

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(manifest.manifestPath, "artifacts/manifest.json");
    assert.deepEqual(manifest.artifacts.map((entry) => entry.path), ["artifacts/a.txt", "artifacts/b.log"]);
    assert.deepEqual(manifest.artifacts.map((entry) => entry.sizeBytes), [2, 4]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildArtifactManifest supports executions with no task artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-no-artifacts-"));
  try {
    const manifest = await buildArtifactManifest(dir, []);
    assert.equal(manifest.schemaVersion, 1);
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
