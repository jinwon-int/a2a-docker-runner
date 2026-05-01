import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import type { RunnerConfig, RunnerEngine, RunnerExtraMount } from "./types.js";

const DEFAULT_ROOT = "/var/lib/openclaw-a2a/tasks";
const DEFAULT_IMAGE = "node:22-bookworm-slim";

export async function loadConfig(env = process.env): Promise<RunnerConfig> {
  const engine = normalizeEngine(env.A2A_DOCKER_RUNNER_ENGINE) ?? (env.A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT ? "docker" : detectEngine());
  const githubTokenFile = env.A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE;
  if (githubTokenFile && existsSync(githubTokenFile)) {
    await access(githubTokenFile, constants.R_OK);
  }

  const patchCommand = loadPatchCommandConfig(env);
  const extraMounts = loadExtraMounts(env);
  validatePatchExecutorPolicy(patchCommand, extraMounts);

  return {
    rootDir: env.A2A_DOCKER_RUNNER_ROOT || DEFAULT_ROOT,
    engine,
    image: env.A2A_DOCKER_RUNNER_IMAGE || DEFAULT_IMAGE,
    githubTokenFile,
    defaultTimeoutMs: Number(env.A2A_DOCKER_RUNNER_TIMEOUT_MS || 15 * 60 * 1000),
    memory: env.A2A_DOCKER_RUNNER_MEMORY || "2g",
    cpus: env.A2A_DOCKER_RUNNER_CPUS || "2",
    extraMounts,
    ...patchCommand,
  };
}

function loadExtraMounts(env: NodeJS.ProcessEnv): RunnerExtraMount[] | undefined {
  const raw = env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON;
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${msg}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: expected an array");
  }

  return parsed.map((entry, index): RunnerExtraMount => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`invalid extra mount at index ${index}: expected object`);
    }

    const record = entry as Record<string, unknown>;
    const source = record.source;
    const target = record.target;
    const readOnly = record.readOnly;
    if (typeof source !== "string" || !source.startsWith("/")) {
      throw new Error(`invalid extra mount at index ${index}: source must be an absolute path`);
    }
    if (typeof target !== "string" || !target.startsWith("/")) {
      throw new Error(`invalid extra mount at index ${index}: target must be an absolute path`);
    }
    if (readOnly !== undefined && typeof readOnly !== "boolean") {
      throw new Error(`invalid extra mount at index ${index}: readOnly must be boolean`);
    }
    return { source, target, readOnly };
  });
}

function loadPatchCommandConfig(env: NodeJS.ProcessEnv): Pick<RunnerConfig, "commandScript" | "commandJson" | "commandTemplate"> {
  const commandScript = env.A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT || undefined;
  if (commandScript) return { commandScript };

  const commandJson = env.A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON || undefined;
  if (commandJson) return { commandJson };

  return { commandTemplate: env.A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE || undefined };
}

function validatePatchExecutorPolicy(
  patchCommand: Pick<RunnerConfig, "commandScript" | "commandJson" | "commandTemplate">,
  extraMounts?: RunnerExtraMount[],
): void {
  if (patchCommand.commandTemplate) {
    throw new Error(
      "A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE is disabled for GitHub patch execution; " +
      "use commandScript or commandJson with an OpenClaw or Codex executor",
    );
  }

  for (const [key, value] of Object.entries(patchCommand)) {
    if (!value) continue;
    if (referencesClaudeExecutor(value)) {
      throw new Error(
        `${key} references Claude-in-Docker, which is not an allowed Docker patch executor; ` +
        "use OpenClaw or Codex via commandScript or commandJson",
      );
    }
    if (!referencesAllowedPatchExecutor(value)) {
      throw new Error(
        `${key} must invoke an allowed Docker patch executor: OpenClaw or Codex`,
      );
    }
  }

  for (const mount of extraMounts ?? []) {
    if (referencesClaudeMount(mount.source) || referencesClaudeMount(mount.target)) {
      throw new Error(
        "extraMounts reference Claude credentials, which are not allowed in Docker patch execution; " +
        "mount only OpenClaw/Codex-specific credentials or scratch paths",
      );
    }
  }
}


function referencesClaudeExecutor(value: string): boolean {
  return [
    /@anthropic-ai\/claude-code/i,
    /(^|[\s;|&"'`])claude([\s;|&"'`-]|$)/i,
    /\.claude(?:\.json|\/|$)/i,
    /claude-(?:install|output|prompt)\.log|claude-prompt\.md/i,
  ].some((pattern) => pattern.test(value));
}

function referencesClaudeMount(value: string): boolean {
  return /(^|\/)\.claude(?:\.json|\/|$)/i.test(value) || /(^|\/)claude(?:\.json|-dir)?$/i.test(value);
}

function referencesAllowedPatchExecutor(value: string): boolean {
  return referencesOpenClawExecutor(value) || referencesCodexExecutor(value);
}

function referencesOpenClawExecutor(value: string): boolean {
  return [
    /(^|[\s;|&"'`/])openclaw([\s;|&"'`-]|$)/i,
    /node_modules\/openclaw\//i,
    /npm\s+(?:install|i)\s+(?:-g\s+)?openclaw/i,
  ].some((pattern) => pattern.test(value));
}

function referencesCodexExecutor(value: string): boolean {
  return [
    /(^|[\s;|&"'`/])codex([\s;|&"'`-]|$)/i,
    /@openai\/codex/i,
    /openai-codex/i,
  ].some((pattern) => pattern.test(value));
}

function normalizeEngine(value?: string): RunnerEngine | undefined {
  if (value === "docker" || value === "podman") return value;
  if (!value) return undefined;
  throw new Error(`unsupported container engine: ${value}`);
}

function detectEngine(): RunnerEngine {
  for (const engine of ["docker", "podman"] as const) {
    const result = spawnSync(engine, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return engine;
  }
  throw new Error("neither docker nor podman is available");
}
