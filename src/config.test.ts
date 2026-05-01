import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const baseEnv = {
  A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
};

test("loadConfig reads OpenClaw patch command script env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\nopenclaw agent --help",
  });

  assert.equal(config.commandScript, "#!/usr/bin/env bash\nopenclaw agent --help");
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
