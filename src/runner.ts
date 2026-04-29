import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { RunnerConfig, RunnerResult, RunnerTask } from "./types.js";

export async function runTask(config: RunnerConfig, task: RunnerTask): Promise<RunnerResult> {
  validateTask(task);
  const root = resolve(config.rootDir);
  const workDir = join(root, safeId(task.id));
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await writeFile(join(workDir, "task.json"), JSON.stringify(task, null, 2));

  const script = buildContainerScript(task);
  await writeFile(join(workDir, "run.sh"), script, { mode: 0o700 });

  const args = buildRunArgs(config, task, workDir);
  const timeoutMs = task.timeoutMs ?? config.defaultTimeoutMs;
  const completed = await spawnWithTimeout(config.engine ?? "docker", args, timeoutMs);
  const artifacts = await listArtifacts(workDir);

  return {
    ok: completed.code === 0 && !completed.timedOut,
    taskId: task.id,
    status: completed.timedOut ? "timeout" : completed.code === 0 ? "completed" : "failed",
    workDir,
    exitCode: completed.code,
    signal: completed.signal,
    stdout: completed.stdout,
    stderr: completed.stderr,
    artifacts,
    prUrl: extractPrUrl(completed.stdout),
    error: completed.code === 0 && !completed.timedOut ? undefined : completed.stderr || completed.stdout,
  };
}

function validateTask(task: RunnerTask): void {
  if (!task.id) throw new Error("task.id is required");
  if (!task.intent) throw new Error("task.intent is required");
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

function buildRunArgs(config: RunnerConfig, task: RunnerTask, workDir: string): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    `a2a-${safeId(task.id)}`,
    "--network",
    "bridge",
    "--memory",
    config.memory ?? "2g",
    "--cpus",
    config.cpus ?? "2",
    "-v",
    `${workDir}:/work`,
    "-w",
    "/work",
  ];

  if (config.githubTokenFile) {
    args.push("-v", `${config.githubTokenFile}:/run/secrets/gh-hosts.yml:ro`);
    args.push("-e", "GH_CONFIG_HOSTS=/run/secrets/gh-hosts.yml");
  }

  for (const [key, value] of Object.entries(task.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(config.image, "bash", "/work/run.sh");
  return args;
}

function buildContainerScript(task: RunnerTask): string {
  const repo = task.repo ? shellQuote(task.repo) : "";
  const base = shellQuote(task.baseBranch ?? "main");
  return `#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work/artifacts
printf 'A2A Docker Runner task %s\\n' ${shellQuote(task.id)} | tee /work/artifacts/summary.txt
printf 'intent=%s\\n' ${shellQuote(task.intent)} | tee -a /work/artifacts/summary.txt
if [ -n "${repo}" ]; then
  if ! command -v git >/dev/null 2>&1; then
    apt-get update >/dev/null
    apt-get install -y git ca-certificates >/dev/null
  fi
  git clone --depth=1 --branch ${base} ${repo} /work/repo
fi
cat /work/task.json > /work/artifacts/task.json
# MVP placeholder: actual OpenClaw/GitHub patch execution is wired in the next iteration.
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function spawnWithTimeout(command: string, args: string[], timeoutMs: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function listArtifacts(workDir: string): Promise<string[]> {
  const dir = join(workDir, "artifacts");
  try {
    const entries = await readdir(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry);
      if ((await stat(path)).isFile()) files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

function extractPrUrl(stdout: string): string | undefined {
  return stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
}
