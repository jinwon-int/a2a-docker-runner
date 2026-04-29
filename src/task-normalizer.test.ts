import assert from "node:assert/strict";
import test from "node:test";
import { defaultCheckoutPath, normalizeRepoUrl, normalizeTask } from "./task-normalizer.js";

test("normalizes GitHub shorthand repo URLs", () => {
  assert.equal(normalizeRepoUrl("jinon86/openclaw-plugin-a2a"), "https://github.com/jinon86/openclaw-plugin-a2a.git");
  assert.equal(normalizeRepoUrl("https://github.com/jinon86/openclaw-plugin-a2a.git"), "https://github.com/jinon86/openclaw-plugin-a2a.git");
});

test("derives stable checkout paths", () => {
  assert.equal(defaultCheckoutPath("https://github.com/jinon86/openclaw-plugin-a2a.git"), "openclaw-plugin-a2a");
  assert.equal(defaultCheckoutPath("jinon86/openclaw-plugin-a2a"), "openclaw-plugin-a2a");
});

test("expands openclaw-plugin-a2a preset into repo checkout and test commands", () => {
  const task = normalizeTask({
    id: "plugin-dev",
    intent: "propose_patch",
    preset: "openclaw-plugin-a2a-dev",
  });

  assert.deepEqual(task.repos, [{
    name: "openclaw-plugin-a2a",
    url: "https://github.com/jinon86/openclaw-plugin-a2a.git",
    branch: "main",
    path: "openclaw-plugin-a2a",
    primary: true,
  }]);
  assert.deepEqual(task.commands, [
    "cd /work/openclaw-plugin-a2a && npm ci",
    "cd /work/openclaw-plugin-a2a && npm test",
  ]);
});

test("keeps explicit multi-repo and command configuration", () => {
  const task = normalizeTask({
    id: "integration-dev",
    intent: "propose_patch",
    repos: [
      { name: "plugin", url: "jinon86/openclaw-plugin-a2a", path: "plugin", primary: true },
      { name: "core", url: "jinon86/openclaw", path: "openclaw", branch: "develop" },
    ],
    commands: ["cd /work/plugin && npm ci", "cd /work/plugin && npm test"],
  });

  assert.equal(task.repos.length, 2);
  assert.equal(task.repos[0]?.url, "https://github.com/jinon86/openclaw-plugin-a2a.git");
  assert.equal(task.repos[0]?.path, "plugin");
  assert.equal(task.repos[1]?.branch, "develop");
  assert.deepEqual(task.commands, ["cd /work/plugin && npm ci", "cd /work/plugin && npm test"]);
});
