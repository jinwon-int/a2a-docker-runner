import { mkdir, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { normalizeTask } from "./task-normalizer.js";
import { collectGitHubEvidence } from "./github-evidence.js";
import type { NormalizedRunnerTask, RunnerConfig, RunnerResult, RunnerTask } from "./types.js";

export async function runTask(config: RunnerConfig, task: RunnerTask): Promise<RunnerResult> {
  validateTask(task);
  const normalizedTask = normalizeTask(task);
  const root = resolve(config.rootDir);
  const workDir = join(root, safeId(task.id));
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await writeFile(join(workDir, "task.json"), JSON.stringify(normalizedTask, null, 2));

  // Write safe patch command script if configured.
  // Priority: commandScript > commandJson > commandTemplate (legacy eval).
  if (config.commandScript) {
    await writeFile(join(workDir, "patch-command.sh"), config.commandScript, { mode: 0o700 });
  } else if (config.commandJson) {
    const jsonScript = jsonArgvToScript(config.commandJson);
    await writeFile(join(workDir, "patch-command.sh"), jsonScript, { mode: 0o700 });
  }

  const script = buildContainerScript(normalizedTask);
  await writeFile(join(workDir, "run.sh"), script, { mode: 0o700 });

  const args = buildRunArgs(config, normalizedTask, workDir);
  const timeoutMs = normalizedTask.timeoutMs ?? config.defaultTimeoutMs;
  const engine = config.engine ?? "docker";
  const completed = await spawnWithTimeout(engine, args, timeoutMs);
  const artifacts = await listArtifacts(workDir);

  const result: RunnerResult = {
    ok: completed.code === 0 && !completed.timedOut,
    taskId: task.id,
    status: completed.timedOut ? "timeout" : completed.code === 0 ? "completed" : "failed",
    workDir,
    exitCode: completed.code,
    signal: completed.signal,
    stdout: redactSecrets(completed.stdout),
    stderr: redactSecrets(completed.stderr),
    artifacts,
    prUrl: extractPrUrl(completed.stdout),
    error: completed.code === 0 && !completed.timedOut ? undefined : buildActionableError(engine, config.image, completed),
  };

  // Collect structured GitHub evidence for propose_patch / github-propose-patch mode.
  const github = await collectGitHubEvidence(config, normalizedTask, result);
  if (github) {
    result.github = github;
    // Backward-compatible: promote to top-level prUrl if github.prUrl is set.
    if (github.prUrl && !result.prUrl) result.prUrl = github.prUrl;
  }

  return result;
}

function validateTask(task: RunnerTask): void {
  if (!task.id) throw new Error("task.id is required");
  if (!task.intent) throw new Error("task.intent is required");
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

export function buildRunArgs(config: RunnerConfig, task: RunnerTask, workDir: string): string[] {
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

  // Escape hatch: inject the patch command template as an env var so
  // default github-propose-patch commands can invoke a coding agent.
  // Safe patch command paths (in priority order).
  // commandScript (file) and commandJson (JSON argv/env) avoid eval.
  // Legacy commandTemplate is injected for backward compatibility only.
  if (config.commandScript || config.commandJson) {
    // Only inject the legacy env var if explicitly requested via commandTemplate.
    // Safer paths use script files or JSON argv.
  }
  if (config.commandJson) {
    args.push("-e", `A2A_PATCH_COMMAND_JSON=${config.commandJson}`);
  }
  if (config.commandTemplate) {
    args.push("-e", `A2A_PATCH_COMMAND=${config.commandTemplate}`);
  }

  for (const [key, value] of Object.entries(task.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(config.image, "bash", "/work/run.sh");
  return args;
}

export function buildContainerScript(task: NormalizedRunnerTask): string {
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

/**
 * Convert a JSON argv/env config into a safe bash script.
 *
 * Input:  {"argv":["codex","exec","--full-auto","..."],"env":{"KEY":"val"}}
 * Output: A self-contained bash script that executes argv safely,
 *         with optional env vars set, and never calls eval.
 */
export function jsonArgvToScript(json: string): string {
  let parsed: { argv?: unknown; env?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `#!/usr/bin/env bash
set -euo pipefail
printf 'error=json_parse_failed: %s\\n' >&2 "${shellQuote(msg)}"
exit 2
`;
  }

  if (!Array.isArray(parsed.argv) || parsed.argv.length === 0 || !parsed.argv.every((a): a is string => typeof a === "string")) {
    return `#!/usr/bin/env bash
set -euo pipefail
printf 'error=invalid_json_argv: argv must be a non-empty array of strings\\n' >&2
exit 2
`;
  }

  const envLines: string[] = [];
  if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
    for (const [key, value] of Object.entries(parsed.env as Record<string, unknown>)) {
      if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        envLines.push(`export ${key}=${shellQuote(value)}`);
      }
    }
  }

  const argvQuoted = parsed.argv.map((a: string) => shellQuote(a)).join(" ");

  return `#!/usr/bin/env bash
set -euo pipefail
${envLines.join("\n")}
${envLines.length ? "\n" : ""}exec ${argvQuoted}
`;
}

export function redactSecrets(value: string): string {
  return value
    // GitHub tokens (classic + fine-grained + PAT v2)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "<redacted-github-token>")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "<redacted-github-token>")
    // xai / supermemory / openai API key patterns (synthetic format)
    // Must fire BEFORE generic key=value redaction to catch the full key.
    .replace(/xai-[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sm_[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, "<redacted-api-key>")
    // x-access-token in URLs
    .replace(/x-access-token:[^@\s]+@github\.com/g, "x-access-token:<redacted>@github.com")
    // oauth_token in YAML/JSON
    .replace(/(oauth_token:\s*)\S+/gi, "$1<redacted>")
    // Authorization / Bearer headers
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/(gh auth login --with-token\s+)\S+/gi, "$1<redacted>")
    // Generic key=value secrets (after API key patterns)
    .replace(/((?:token|password|secret|api[_-]?key)=)(?!<redacted)[^\s]+/gi, "$1<redacted>")
    // Shell variable assignments with secrets
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|A2A_TOKEN)=)['"]?[^'"\s]+['"]?/gi, "$1<redacted>");
}

function buildActionableError(engine: string, image: string, completed: SpawnResult): string {
  const combined = redactSecrets([completed.stderr, completed.stdout].filter(Boolean).join("\n")).trim();
  if (completed.errorCode === "ENOENT") {
    return `${engine} 실행 파일을 찾을 수 없습니다. Docker 또는 Podman을 설치하거나 A2A_DOCKER_RUNNER_ENGINE을 사용 가능한 엔진으로 설정하세요.`;
  }
  if (completed.timedOut) {
    return `컨테이너 실행이 제한 시간 안에 끝나지 않았습니다. timeoutMs를 늘리거나 작업 명령을 줄이고, 남은 컨테이너가 있으면 '${engine} ps -a'와 '${engine} rm -f a2a-<taskId>'로 확인하세요.\n${combined}`.trim();
  }
  if (/pull access denied|manifest unknown|not found|no such image|repository does not exist/i.test(combined)) {
    return `이미지 '${image}'를 가져오거나 찾을 수 없습니다. 이미지 이름/태그와 registry 인증을 확인하세요.\n${combined}`.trim();
  }
  if (/permission denied|cannot connect to the docker daemon|got permission denied|operation not permitted|rootless/i.test(combined)) {
    return `${engine} 실행 권한 또는 daemon 연결 권한이 없습니다. runner 사용자 권한, socket 접근, rootless Podman 설정을 확인하세요.\n${combined}`.trim();
  }
  return combined || `${engine} 실행이 실패했습니다(exit=${completed.code ?? "null"}, signal=${completed.signal ?? "none"}).`;
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
}

function spawnWithTimeout(command: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
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
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        signal: null,
        stdout: "",
        stderr: redactSecrets(error.message),
        timedOut,
        errorCode: error.code,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut });
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
