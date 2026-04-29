#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { runEngineSmokeFixture } from "./engine-smoke.js";
import { cleanup, doctor, install } from "./ops.js";
import { runTask } from "./runner.js";
import type { RunnerTask } from "./types.js";

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "run") {
    const task = await readTask(arg);
    const config = await loadConfig();
    const result = await runTask(config, task);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (command === "smoke") {
    const config = await loadConfig();
    console.log(JSON.stringify(await runEngineSmokeFixture(config), null, 2));
    return;
  }

  if (command === "doctor") {
    const config = await loadConfig({ ...process.env, A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" });
    console.log(JSON.stringify(await doctor(config), null, 2));
    return;
  }

  if (command === "install" || command === "setup") {
    const config = await loadConfig({ ...process.env, A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" });
    console.log(JSON.stringify(await install(config), null, 2));
    return;
  }

  if (command === "cleanup") {
    const config = await loadConfig({ ...process.env, A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1" });
    const ttlMs = parseTtlMs(processFlag("--ttl", arg) ?? "24h");
    const dryRun = process.argv.includes("--dry-run");
    console.log(JSON.stringify(await cleanup({ rootDir: config.rootDir, ttlMs, dryRun }), null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function readTask(path?: string): Promise<RunnerTask> {
  const input = path && path !== "-" ? await readFile(path, "utf8") : await readStdin();
  return JSON.parse(input) as RunnerTask;
}

function parseTtlMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`invalid ttl: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function processFlag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return fallback?.startsWith("--") ? undefined : fallback;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

function printHelp(): void {
  console.log(`a2a-docker-runner

Usage:
  a2a-docker-runner doctor
  a2a-docker-runner smoke
  a2a-docker-runner install
  a2a-docker-runner cleanup [--ttl 24h] [--dry-run]
  a2a-docker-runner run <task.json>
  cat task.json | a2a-docker-runner run -
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
