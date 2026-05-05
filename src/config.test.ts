import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const baseEnv = {
  A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
};

test("loadConfig reads bounded safe runner build metadata", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_IMAGE: "ghcr.io/jinwon-int/a2a-docker-runner:ci",
    A2A_DOCKER_RUNNER_BUILD_VERSION: "0.1.0",
    A2A_DOCKER_RUNNER_BUILD_SOURCE: "https://github.com/jinwon-int/a2a-docker-runner",
    A2A_DOCKER_RUNNER_BUILD_REVISION: "0123456789abcdef",
    A2A_DOCKER_RUNNER_BUILD_BUILT_AT: "2026-05-01T00:00:00Z",
  });

  assert.deepEqual(config.buildMetadata, {
    version: "0.1.0",
    source: "https://github.com/jinwon-int/a2a-docker-runner",
    revision: "0123456789abcdef",
    builtAt: "2026-05-01T00:00:00Z",
    image: "ghcr.io/jinwon-int/a2a-docker-runner:ci",
  });
});

test("loadConfig drops unsafe runner build metadata values", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_BUILD_SOURCE: "/root/private/checkout",
    A2A_DOCKER_RUNNER_BUILD_REVISION: "token=ghp_" + "x".repeat(36),
    A2A_DOCKER_RUNNER_BUILD_IMAGE: "safe-image:latest\nignored-line",
  });

  assert.deepEqual(config.buildMetadata, { image: "safe-image:latest ignored-line" });
});

test("loadConfig reads OpenClaw patch command script env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\nopenclaw agent --help",
  });

  assert.equal(config.commandScript, "#!/usr/bin/env bash\nopenclaw agent --help");
});

test("loadConfig builds first-class OpenClaw patch profile", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_OPENCLAW_AGENT_ID: "main",
    A2A_OPENCLAW_THINKING: "medium",
    A2A_OPENCLAW_TIMEOUT_SEC: "1800",
  });

  assert.match(config.commandScript ?? "", /openclaw agent/);
  assert.match(config.commandScript ?? "", /--model 'openai-codex\/gpt-5\.5'/);
  assert.match(config.commandScript ?? "", /--thinking 'medium'/);
  assert.match(config.commandScript ?? "", /OPENCLAW_DISABLE_BUNDLED_PLUGINS='0'/);
  assert.equal(config.network, "host");
  assert.match(config.commandScript ?? "", /copy_file_if_exists \/run\/secrets\/openclaw-dir\/openclaw\.json/);
  assert.match(config.commandScript ?? "", /auth-profiles\.json/);
  assert.match(config.commandScript ?? "", /auth-state\.json/);
  assert.match(config.commandScript ?? "", /models\.json/);
  assert.match(config.commandScript ?? "", /A2A_SANITIZE_OPENCLAW_CONFIG/);
  assert.match(config.commandScript ?? "", /A2A_INJECT_GITHUB_TOKEN_FOR_OPENCLAW/);
  assert.match(config.commandScript ?? "", /config\.skills\.entries\["gh-issues"\]\.apiKey = token/);
  assert.match(config.commandScript ?? "", /export GITHUB_TOKEN/);
  assert.ok((config.commandScript ?? "").includes('JSON.stringify(config, null, 2) + "\\n");'));
  assert.equal((config.commandScript ?? "").includes('JSON.stringify(config, null, 2) + "\n");'), false);
  assert.match(config.commandScript ?? "", /delete config\.plugins/);
  assert.match(config.commandScript ?? "", /delete config\.channels/);
  assert.match(config.commandScript ?? "", /delete defaults\.models/);
  assert.match(config.commandScript ?? "", /delete entry\.models/);
  assert.match(config.commandScript ?? "", /delete defaults\.agentRuntime\.fallback/);
  assert.match(config.commandScript ?? "", /delete entry\.agentRuntime\.fallback/);
  assert.match(config.commandScript ?? "", /openai-codex/);
  assert.match(config.commandScript ?? "", /openclaw_config_bytes=/);
  assert.match(config.commandScript ?? "", /A2A_SET_OPENCLAW_WORKSPACE/);
  assert.match(config.commandScript ?? "", /config\.agents\.defaults\.workspace = workspace/);
  assert.match(config.commandScript ?? "", /entry\.workspace = workspace/);
  assert.match(config.commandScript ?? "", /A2A_GUARD_OPENCLAW_SESSION_STORE/);
  assert.match(config.commandScript ?? "", /openclaw_session_store_guard/);
  assert.match(config.commandScript ?? "", /openclaw_workspace_bootstrap_leak/);
  assert.match(config.commandScript ?? "", /bootstrap_leak=/);
  assert.match(config.commandScript ?? "", /git status --porcelain -- \.openclaw AGENTS\.md BOOTSTRAP\.md HEARTBEAT\.md IDENTITY\.md MEMORY\.md SOUL\.md TOOLS\.md USER\.md memory/);
  assert.match(config.commandScript ?? "", /activeAgentId = process\.env\.A2A_OPENCLAW_AGENT_ID \|\| "main"/);
  assert.ok((config.commandScript ?? "").includes('warning=openclaw_session_store_guard " + warning + "\\n"'));
  assert.ok((config.commandScript ?? "").includes('error=openclaw_session_store_guard " + errors.join("; ") + "\\n"'));
  assert.doesNotMatch(config.commandScript ?? "", /warning=openclaw_session_store_guard " \+ warning \+ "\n"/);
  assert.match(config.commandScript ?? "", /empty active-agent sessions registry/);
  assert.match(config.commandScript ?? "", /empty non-active-agent sessions registry ignored/);
  assert.doesNotMatch(config.commandScript ?? "", /tar -C \/run\/secrets\/openclaw-dir/);
  assert.doesNotMatch(config.commandScript ?? "", /cp -a \/run\/secrets\/openclaw-dir \/root\/\.openclaw/);
  assert.equal(config.commandJson, undefined);
  assert.deepEqual(config.extraMounts, [
    { source: "/root/.openclaw", target: "/run/secrets/openclaw-dir", readOnly: true },
  ]);
});

test("loadConfig OpenClaw patch profile honors custom model", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_OPENCLAW_MODEL: "zai/glm-5.1",
  });

  assert.match(config.commandScript ?? "", /--model 'zai\/glm-5\.1'/);
});

test("loadConfig honors explicit Docker network override", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_NETWORK: "bridge",
  });

  assert.equal(config.network, "bridge");
});

test("loadConfig OpenClaw patch profile honors custom config dir", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR: "/srv/openclaw-profile",
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/srv/openclaw-profile", target: "/run/secrets/openclaw-dir", readOnly: true },
  ]);
});

test("loadConfig rejects unsupported patch command profile", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude",
    }),
    /unsupported A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE/,
  );
});

test("loadConfig reads Codex patch command JSON env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["codex", "exec", "json"] }),
  });

  assert.equal(config.commandJson, '{"argv":["codex","exec","json"]}');
});

test("loadConfig rejects legacy patch command template even with allowed executors", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "openclaw agent --help",
    }),
    /PATCH_COMMAND_TEMPLATE is disabled/,
  );
});

test("loadConfig patch command precedence is script > json > template", async () => {
  const scriptConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "codex exec script",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["codex", "exec", "json"] }),
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "openclaw agent --help",
  });
  assert.equal(scriptConfig.commandScript, "codex exec script");
  assert.equal(scriptConfig.commandJson, undefined);
  assert.equal(scriptConfig.commandTemplate, undefined);

  const jsonConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["codex", "exec", "json"] }),
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "openclaw agent --help",
  });
  assert.equal(jsonConfig.commandScript, undefined);
  assert.equal(jsonConfig.commandJson, '{"argv":["codex","exec","json"]}');
  assert.equal(jsonConfig.commandTemplate, undefined);
});

test("loadConfig reads extra runner mounts", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/var/lib/openclaw/codex", target: "/run/secrets/codex", readOnly: true },
      { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
    ]),
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/var/lib/openclaw/codex", target: "/run/secrets/codex", readOnly: true },
    { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
  ]);
});

test("loadConfig rejects malformed extra runner mounts", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([{ source: "relative", target: "/x" }]),
    }),
    /source must be an absolute path/,
  );
});

test("loadConfig rejects writable OpenClaw runtime/session mounts", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.openclaw/workspace/sessions", target: "/host-sessions", readOnly: false },
      ]),
    }),
    /writable OpenClaw runtime\/session paths are forbidden/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/var/tmp/a2a", target: "/run/secrets/openclaw-dir/agents/main/agent", readOnly: false },
      ]),
    }),
    /writable OpenClaw runtime\/session paths are forbidden/,
  );
});

test("loadConfig blocks Claude-in-Docker patch commands", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "npm install -g @anthropic-ai/claude-code\nclaude --print hello",
    }),
    /Claude-in-Docker.*not an allowed Docker patch executor/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
    }),
    /Claude-in-Docker.*not an allowed Docker patch executor/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "claude --print hello",
    }),
    /PATCH_COMMAND_TEMPLATE is disabled/,
  );
});

test("loadConfig blocks Claude credential mounts", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.claude", target: "/run/secrets/claude-dir" },
      ]),
    }),
    /Claude credentials.*not allowed in Docker patch execution/,
  );
});

test("loadConfig rejects Claude-in-Docker even with the legacy opt-in flag", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_ALLOW_CLAUDE_IN_DOCKER: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
    }),
    /not an allowed Docker patch executor|OpenClaw or Codex/,
  );
});

test("loadConfig rejects patch commands without OpenClaw or Codex", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\ngit status",
    }),
    /allowed Docker patch executor: OpenClaw or Codex/,
  );
});

test("loadConfig allows OpenClaw and Codex Docker patch executors", async () => {
  const openclawConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\nnpm install -g openclaw\nopenclaw agent --local --message hi",
  });
  assert.match(openclawConfig.commandScript ?? "", /openclaw agent/);

  const codexConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["bash", "-lc", "npm install -g @openai/codex && codex exec --help"] }),
  });
  assert.match(codexConfig.commandJson ?? "", /@openai\/codex/);
});
