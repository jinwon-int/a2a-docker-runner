import { mkdir, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { normalizeTask } from "./task-normalizer.js";
import type { NormalizedRunnerTask, RunnerConfig, RunnerResult, RunnerTask } from "./types.js";

export async function runTask(config: RunnerConfig, task: RunnerTask): Promise<RunnerResult> {
  validateTask(task);
  const normalizedTask = normalizeTask(task);
  const root = resolve(config.rootDir);
  const workDir = join(root, safeId(task.id));
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await writeFile(join(workDir, "task.json"), JSON.stringify(normalizedTask, null, 2));

  const script = buildContainerScript(normalizedTask);
  await writeFile(join(workDir, "run.sh"), script, { mode: 0o700 });

  const args = buildRunArgs(config, normalizedTask, workDir);
  const timeoutMs = normalizedTask.timeoutMs ?? config.defaultTimeoutMs;
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

function buildContainerScript(task: NormalizedRunnerTask): string {
  return `#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work/artifacts
printf 'A2A Docker Runner task %s\n' ${shellQuote(task.id)} | tee /work/artifacts/summary.txt
printf 'intent=%s\n' ${shellQuote(task.intent)} | tee -a /work/artifacts/summary.txt
printf 'preset=%s\n' ${shellQuote(task.preset ?? "")} | tee -a /work/artifacts/summary.txt
${installBaseToolsScript()}
${githubAuthScript()}
${checkoutReposScript(task)}
cat /work/task.json > /work/artifacts/task.json
${runCommandsScript(task)}
printf 'status=completed\n' | tee -a /work/artifacts/summary.txt
`;
}

function installBaseToolsScript(): string {
  return `if ! command -v git >/dev/null 2>&1; then
  apt-get update >/dev/null
  apt-get install -y git ca-certificates >/dev/null
fi
`;
}

function githubAuthScript(): string {
  return `if [ -r /run/secrets/gh-hosts.yml ]; then
  token=$(sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' /run/secrets/gh-hosts.yml | head -n 1)
  if [ -n "$token" ]; then
    cat > /tmp/git-askpass <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\\n' "x-access-token" ;;
  *Password*) sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' /run/secrets/gh-hosts.yml | head -n 1 ;;
  *) printf '\\n' ;;
esac
ASKPASS
    chmod 700 /tmp/git-askpass
    export GIT_ASKPASS=/tmp/git-askpass
    export GIT_TERMINAL_PROMPT=0
    printf 'github_auth=hosts.yml\\n' | tee -a /work/artifacts/summary.txt
  fi
fi
`;
}

function checkoutReposScript(task: NormalizedRunnerTask): string {
  if (!task.repos.length) return "";
  return task.repos.map((repo) => {
    return `printf 'checkout %s %s -> %s\n' ${shellQuote(repo.name ?? repo.url)} ${shellQuote(repo.branch ?? "main")} ${shellQuote(repo.path ?? "repo")} | tee -a /work/artifacts/summary.txt
git clone --depth=1 --branch ${shellQuote(repo.branch ?? "main")} ${shellQuote(repo.url)} ${shellQuote(`/work/${repo.path ?? "repo"}`)}
`;
  }).join("\n");
}

function runCommandsScript(task: NormalizedRunnerTask): string {
  if (!task.commands.length) {
    return "printf 'commands=none\\n' | tee -a /work/artifacts/summary.txt\n";
  }

  const commands = task.commands.map((command, index) => {
    return `printf 'command[%s]=%s\n' ${shellQuote(String(index))} ${shellQuote(command)} | tee -a /work/artifacts/summary.txt
(${command}) 2>&1 | tee /work/artifacts/command-${index}.log
`;
  }).join("\n");

  return `printf 'commands=%s\n' ${shellQuote(String(task.commands.length))} | tee -a /work/artifacts/summary.txt
${commands}`;
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
