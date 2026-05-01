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

  const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);

  return {
    rootDir: env.A2A_DOCKER_RUNNER_ROOT || DEFAULT_ROOT,
    engine,
    image: env.A2A_DOCKER_RUNNER_IMAGE || DEFAULT_IMAGE,
    githubTokenFile,
    defaultTimeoutMs: Number(env.A2A_DOCKER_RUNNER_TIMEOUT_MS || 15 * 60 * 1000),
    memory: env.A2A_DOCKER_RUNNER_MEMORY || "2g",
    cpus: env.A2A_DOCKER_RUNNER_CPUS || "2",
    network: env.A2A_DOCKER_RUNNER_NETWORK || (profile === "openclaw" ? "host" : "bridge"),
    extraMounts,
    ...patchCommand,
  };
}

function loadExtraMounts(env: NodeJS.ProcessEnv): RunnerExtraMount[] | undefined {
  const raw = env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON;
  if (!raw) {
    const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
    if (profile === "openclaw") {
      return [{
        source: env.A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR || "/root/.openclaw",
        target: "/run/secrets/openclaw-dir",
        readOnly: true,
      }];
    }
    return undefined;
  }

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

  const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
  if (profile === "openclaw") return { commandScript: buildOpenClawPatchCommandScript(env) };

  return { commandTemplate: env.A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE || undefined };
}

function normalizePatchCommandProfile(value?: string): "openclaw" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "openclaw") return "openclaw";
  throw new Error(`unsupported A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: ${value}`);
}

function buildOpenClawPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const agent = shellSingleQuote(env.A2A_OPENCLAW_AGENT_ID || "main");
  const model = shellSingleQuote(env.A2A_OPENCLAW_MODEL || "openai-codex/gpt-5.5");
  const thinking = shellSingleQuote(env.A2A_OPENCLAW_THINKING || "medium");
  const timeout = shellSingleQuote(env.A2A_OPENCLAW_TIMEOUT_SEC || "1800");
  const disableBundledPlugins = shellSingleQuote(env.A2A_OPENCLAW_DISABLE_BUNDLED_PLUGINS || "0");
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=${disableBundledPlugins}

if [ ! -d /run/secrets/openclaw-dir ]; then
  printf 'error=openclaw_config_mount_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw and mount an OpenClaw config dir via A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\\n' | tee /work/artifacts/patch-command.log
  exit 2
fi

if ! command -v openclaw >/dev/null 2>&1; then
  npm install -g openclaw >/work/artifacts/openclaw-install.log 2>&1
fi

rm -rf /root/.openclaw
mkdir -p /root/.openclaw/agents/${agent}/agent

# Copy only the authentication/configuration files needed by the embedded
# OpenClaw process.  Worker hosts can have multi-GB workspaces, caches,
# plugin runtimes, archives, and session logs under ~/.openclaw; a broad copy
# makes Docker patch execution look stuck before the agent even starts.
copy_file_if_exists() {
  src="$1"
  dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
  fi
}

copy_dir_if_exists() {
  src="$1"
  dst="$2"
  if [ -d "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
}

copy_file_if_exists /run/secrets/openclaw-dir/openclaw.json /root/.openclaw/openclaw.json
copy_file_if_exists /run/secrets/openclaw-dir/node.json /root/.openclaw/node.json
copy_dir_if_exists /run/secrets/openclaw-dir/credentials /root/.openclaw/credentials
copy_file_if_exists /run/secrets/openclaw-dir/agents/${agent}/agent/auth-profiles.json /root/.openclaw/agents/${agent}/agent/auth-profiles.json
copy_file_if_exists /run/secrets/openclaw-dir/agents/${agent}/agent/auth-state.json /root/.openclaw/agents/${agent}/agent/auth-state.json
copy_file_if_exists /run/secrets/openclaw-dir/agents/${agent}/agent/models.json /root/.openclaw/agents/${agent}/agent/models.json

if [ -f /root/.openclaw/openclaw.json ]; then
  node <<'A2A_SANITIZE_OPENCLAW_CONFIG'
const fs = require("node:fs");
const path = "/root/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));

// The host gateway config can reference runtime-only plugins, channel targets,
// and API-key providers that are not present inside the short-lived Docker
// patch container. Keep the model/auth information needed by openclaw agent,
// but drop gateway/plugin/channel wiring so config validation does not fail
// before the OAuth-backed agent can start.
delete config.plugins;
delete config.channels;
delete config.gateway;
delete config.cron;
delete config.bindings;
delete config.hooks;

const providers = config.models?.providers;
if (providers && typeof providers === "object" && providers["openai-codex"]) {
  config.models.providers = { "openai-codex": providers["openai-codex"] };
}

const defaults = config.agents?.defaults;
if (defaults && typeof defaults === "object") {
  delete defaults.heartbeat;
  if (defaults.model && typeof defaults.model === "object") {
    defaults.model.primary = "openai-codex/gpt-5.5";
    defaults.model.fallbacks = [];
  }
  delete defaults.models;
}

const agentList = config.agents?.list;
if (Array.isArray(agentList)) {
  for (const entry of agentList) {
    if (!entry || typeof entry !== "object") continue;
    delete entry.heartbeat;
    delete entry.models;
    if (entry.model && typeof entry.model === "object") {
      entry.model.primary = "openai-codex/gpt-5.5";
      entry.model.fallbacks = [];
    }
  }
}

fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
A2A_SANITIZE_OPENCLAW_CONFIG
fi

chmod -R u+rwX /root/.openclaw
printf 'openclaw_config_bytes=%s\n' "$(du -sb /root/.openclaw | awk '{print $1}')" | tee -a /work/artifacts/summary.txt

cat > /work/artifacts/openclaw-prompt.md <<'A2A_OPENCLAW_PROMPT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.

Use /work/artifacts/prompt.md as the assignment. Complete a minimal, safe patch in the current repository only.

Rules:
- Use OpenClaw tools available inside this container.
- Do not run git commit, git push, or gh pr create; the runner will do that after you exit.
- Do not write secrets, host-specific private paths, or raw session dumps.
- Prefer small focused changes and tests.
- If the assignment is unsafe or impossible, explain why and exit non-zero without changing files.
- If no safe code/doc change is needed, exit non-zero so the runner posts Block evidence instead of a false Done.
A2A_OPENCLAW_PROMPT_EOF

printf '\\n--- A2A assignment ---\\n' >> /work/artifacts/openclaw-prompt.md
cat /work/artifacts/prompt.md >> /work/artifacts/openclaw-prompt.md

OPENCLAW_ASSIGNMENT_PROMPT="$(cat /work/artifacts/openclaw-prompt.md)"
openclaw agent \\
  --local \\
  --agent ${agent} \\
  --model ${model} \\
  --message "$OPENCLAW_ASSIGNMENT_PROMPT" \\
  --thinking ${thinking} \\
  --timeout ${timeout} \\
  --json \\
  2>&1 | tee /work/artifacts/openclaw-output.txt

if [ -z "$(git status --porcelain)" ]; then
  printf 'error=openclaw_completed_without_changes\\n' | tee -a /work/artifacts/summary.txt
  printf 'OpenClaw produced no repository changes; refusing false Done.\\n' | tee -a /work/artifacts/patch-command.log
  exit 2
fi
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
