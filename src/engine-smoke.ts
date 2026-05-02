import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "./runner.js";
import type { RunnerConfig, RunnerResult } from "./types.js";

export const DEFAULT_SMOKE_TIMEOUT_MS = 120_000;

export interface SmokeFixtureResult {
  ok: boolean;
  engine: string;
  image: string;
  result: RunnerResult;
  notes: string[];
}

export function resolveSmokeTimeoutMs(configDefaultTimeoutMs: number): number {
  if (!Number.isFinite(configDefaultTimeoutMs) || configDefaultTimeoutMs <= 0) return DEFAULT_SMOKE_TIMEOUT_MS;
  return Math.min(configDefaultTimeoutMs, DEFAULT_SMOKE_TIMEOUT_MS);
}

export async function runEngineSmokeFixture(config: RunnerConfig): Promise<SmokeFixtureResult> {
  const rootDir = await mkdtemp(join(tmpdir(), "a2a-engine-smoke-"));
  const smokeConfig = { ...config, rootDir, defaultTimeoutMs: resolveSmokeTimeoutMs(config.defaultTimeoutMs) };
  const result = await runTask(smokeConfig, {
    id: "engine-smoke",
    intent: "smoke",
    commands: [
      "printf 'stdout: engine smoke ok\\n'",
      "printf 'stderr: diagnostic channel ok\\n' >&2",
      "printf 'artifact: smoke\\n' > /work/artifacts/smoke.txt",
    ],
    timeoutMs: smokeConfig.defaultTimeoutMs,
  });

  const notes = [
    "stdout/stderr/artifact collection exercised",
    "container is started with --rm for engine-side cleanup",
    `smoke timeout: ${smokeConfig.defaultTimeoutMs}ms`,
    `host work root: ${rootDir}`,
  ];

  if (result.artifacts.length > 0) {
    const readableArtifact = result.artifacts.find((path) => path.endsWith("smoke.txt"));
    if (readableArtifact) {
      notes.push(`artifact smoke.txt=${(await readFile(readableArtifact, "utf8")).trim()}`);
    }
  }

  await rm(rootDir, { recursive: true, force: true });
  await writeFile(join(tmpdir(), "a2a-docker-runner-last-smoke.json"), JSON.stringify({ ok: result.ok, status: result.status }, null, 2));

  return {
    ok: result.ok,
    engine: smokeConfig.engine ?? "docker",
    image: smokeConfig.image,
    result: { ...result, workDir: "<removed smoke workdir>", artifacts: result.artifacts.map((path) => path.replace(rootDir, "<removed smoke workdir>")) },
    notes,
  };
}
