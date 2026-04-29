#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
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

  if (command === "doctor") {
    const config = await loadConfig();
    console.log(JSON.stringify({ ok: true, config: { ...config, githubTokenFile: config.githubTokenFile ? "configured" : undefined } }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function readTask(path?: string): Promise<RunnerTask> {
  const input = path && path !== "-" ? await readFile(path, "utf8") : await readStdin();
  return JSON.parse(input) as RunnerTask;
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
  a2a-docker-runner run <task.json>
  cat task.json | a2a-docker-runner run -
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
