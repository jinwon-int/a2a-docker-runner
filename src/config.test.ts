import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const baseEnv = {
  A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
};

test("loadConfig reads safe patch command script env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\necho safe",
  });

  assert.equal(config.commandScript, "#!/usr/bin/env bash\necho safe");
});

test("loadConfig reads safe patch command JSON env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["echo", "json"] }),
  });

  assert.equal(config.commandJson, '{"argv":["echo","json"]}');
});

test("loadConfig keeps legacy patch command template for compatibility", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "echo legacy",
  });

  assert.equal(config.commandTemplate, "echo legacy");
});

test("loadConfig patch command precedence is script > json > template", async () => {
  const scriptConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "echo script",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["echo", "json"] }),
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "echo legacy",
  });
  assert.equal(scriptConfig.commandScript, "echo script");
  assert.equal(scriptConfig.commandJson, undefined);
  assert.equal(scriptConfig.commandTemplate, undefined);

  const jsonConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["echo", "json"] }),
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "echo legacy",
  });
  assert.equal(jsonConfig.commandScript, undefined);
  assert.equal(jsonConfig.commandJson, '{"argv":["echo","json"]}');
  assert.equal(jsonConfig.commandTemplate, undefined);

  const legacyConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "echo legacy",
  });
  assert.equal(legacyConfig.commandScript, undefined);
  assert.equal(legacyConfig.commandJson, undefined);
  assert.equal(legacyConfig.commandTemplate, "echo legacy");
});

test("loadConfig reads extra runner mounts", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/root/.claude", target: "/run/secrets/claude-dir" },
      { source: "/root/.claude.json", target: "/run/secrets/claude.json", readOnly: true },
      { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
    ]),
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/root/.claude", target: "/run/secrets/claude-dir", readOnly: undefined },
    { source: "/root/.claude.json", target: "/run/secrets/claude.json", readOnly: true },
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
