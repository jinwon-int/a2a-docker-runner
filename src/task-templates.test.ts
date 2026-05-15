// ─────────────────────────────────────────────────────────────────────────────
// Task Templates Tests (Team1 nosuk lane, A2A R23)
// Parent: a2a-docker-runner#261
// ─────────────────────────────────────────────────────────────────────────────

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTemplate,
  getTemplate,
  listTemplates,
  resolveTemplate,
  expandVars,
  expandTask,
  buildTemplateExpansionEvidence,
} from "./task-templates.js";
import type { RunnerTask, TaskTemplate } from "./types.js";

// ---------------------------------------------------------------------------
// Template Registration
// ---------------------------------------------------------------------------

test("registers and retrieves a template", () => {
  const template: TaskTemplate = {
    id: "test-template",
    version: "1.0.0",
    label: "Test Template",
    commands: ["echo 'hello ${NAME}'"],
  };

  registerTemplate(template);
  const retrieved = getTemplate("test-template");
  assert.ok(retrieved);
  assert.equal(retrieved.id, "test-template");
  assert.equal(retrieved.version, "1.0.0");
});

test("throws on duplicate template id", () => {
  assert.throws(() => {
    registerTemplate({ id: "test-template", commands: [] });
  }, /already registered/);
});

test("lists registered template ids", () => {
  const ids = listTemplates();
  assert.ok(ids.includes("test-template"));
});

test("getTemplate returns undefined for unknown id", () => {
  assert.equal(getTemplate("nonexistent"), undefined);
});

// ---------------------------------------------------------------------------
// Template Resolution
// ---------------------------------------------------------------------------

test("resolveTemplate finds built-in by name", () => {
  const task: RunnerTask = { id: "t1", intent: "propose_patch", template: "test-template" };
  const tpl = resolveTemplate(task);
  assert.ok(tpl);
  assert.equal(tpl!.id, "test-template");
});

test("resolveTemplate uses inlineTemplate when no built-in", () => {
  const inline: TaskTemplate = { id: "inline-1", commands: ["echo ok"] };
  const task: RunnerTask = { id: "t2", intent: "propose_patch", inlineTemplate: inline };
  const tpl = resolveTemplate(task);
  assert.ok(tpl);
  assert.equal(tpl!.id, "inline-1");
});

test("resolveTemplate returns undefined when no template configured", () => {
  const task: RunnerTask = { id: "t3", intent: "propose_patch" };
  assert.equal(resolveTemplate(task), undefined);
});

test("resolveTemplate prefers built-in over inline with same id", () => {
  const inline: TaskTemplate = { id: "test-template", commands: ["from inline"] };
  const task: RunnerTask = { id: "t4", intent: "propose_patch", template: "test-template", inlineTemplate: inline };
  const tpl = resolveTemplate(task);
  assert.ok(tpl);
  // Should return the built-in (registered earlier), not the inline.
  assert.equal(tpl!.label, "Test Template");
});

// ---------------------------------------------------------------------------
// Variable Expansion
// ---------------------------------------------------------------------------

test("expandVars replaces ${variables} from map", () => {
  const result = expandVars("Hello ${NAME}, your score is ${SCORE}", { NAME: "Alice", SCORE: "42" });
  assert.equal(result, "Hello Alice, your score is 42");
});

test("expandVars preserves missing variables", () => {
  const result = expandVars("Hello ${NAME}, ${MISSING}", { NAME: "Bob" });
  assert.equal(result, "Hello Bob, ${MISSING}");
});

test("expandVars handles strings with no variables", () => {
  const result = expandVars("plain string", { KEY: "val" });
  assert.equal(result, "plain string");
});

test("expandVars handles empty vars map", () => {
  const result = expandVars("test ${X}", {});
  assert.equal(result, "test ${X}");
});

test("expandVars handles multiple occurrences of the same variable", () => {
  const result = expandVars("${X} + ${X} = ${Y}", { X: "2", Y: "4" });
  assert.equal(result, "2 + 2 = 4");
});

// ---------------------------------------------------------------------------
// Full Task Expansion
// ---------------------------------------------------------------------------

test("expandTask returns copy when no template configured", () => {
  const task: RunnerTask = { id: "plain", intent: "propose_patch", commands: ["echo hi"] };
  const expanded = expandTask(task);
  assert.equal(expanded.id, "plain");
  assert.deepEqual(expanded.commands, ["echo hi"]);
});

test("expandTask throws for unresolvable template reference", () => {
  const task: RunnerTask = { id: "bad", intent: "propose_patch", template: "no-such-template" };
  assert.throws(() => expandTask(task), /not found/);
});

test("expandTask merges template commands with task commands", () => {
  const template: TaskTemplate = {
    id: "merge-cmds",
    commands: ["echo 'template: ${MSG}'"],
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "merge-test",
    intent: "propose_patch",
    template: "merge-cmds",
    templateVars: { MSG: "hello from template" },
    commands: ["echo 'task command'"],
  };
  const expanded = expandTask(task);
  assert.ok(expanded.commands);
  assert.equal(expanded.commands.length, 2);
  assert.equal(expanded.commands[0], "echo 'template: hello from template'");
  assert.equal(expanded.commands[1], "echo 'task command'");
});

test("expandTask merges repos deduped by URL", () => {
  const template: TaskTemplate = {
    id: "merge-repos",
    repos: [{ url: "https://github.com/org/shared.git", branch: "main" }],
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "repo-merge",
    intent: "propose_patch",
    template: "merge-repos",
    repos: [{ url: "https://github.com/org/task-specific.git", branch: "feature" }],
  };
  const expanded = expandTask(task);
  assert.ok(expanded.repos);
  assert.equal(expanded.repos!.length, 2);
});

test("expandTask merges env with task values overriding template", () => {
  const template: TaskTemplate = {
    id: "merge-env",
    env: { SHARED_VAR: "from-template", OVERRIDE_ME: "template-val" },
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "env-merge",
    intent: "propose_patch",
    template: "merge-env",
    env: { OVERRIDE_ME: "task-val", TASK_ONLY: "hello" },
  };
  const expanded = expandTask(task);
  assert.ok(expanded.env);
  assert.equal(expanded.env!.SHARED_VAR, "from-template");
  assert.equal(expanded.env!.OVERRIDE_ME, "task-val");
  assert.equal(expanded.env!.TASK_ONLY, "hello");
});

test("expandTask uses task fields over template defaults", () => {
  const template: TaskTemplate = {
    id: "field-override",
    mode: "github-propose-patch",
    baseBranch: "main",
    timeoutMs: 300000,
    reportLanguage: "ko",
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "override-test",
    intent: "propose_patch",
    template: "field-override",
    mode: "github-propose-patch",
    timeoutMs: 600000,
  };
  const expanded = expandTask(task);
  assert.equal(expanded.mode, "github-propose-patch");
  assert.equal(expanded.baseBranch, "main"); // from template
  assert.equal(expanded.timeoutMs, 600000);   // task wins
});

test("expandTask expands template prompt when task has none", () => {
  const template: TaskTemplate = {
    id: "prompt-fallback",
    prompt: "Do something with ${TOPIC}",
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "prompt-test",
    intent: "propose_patch",
    template: "prompt-fallback",
    templateVars: { TOPIC: "documentation" },
  };
  const expanded = expandTask(task);
  assert.equal(expanded.prompt, "Do something with documentation");
});

test("expandTask uses task prompt over template prompt", () => {
  const template: TaskTemplate = {
    id: "prompt-override",
    prompt: "from template",
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "prompt-override-test",
    intent: "propose_patch",
    template: "prompt-override",
    prompt: "from task",
  };
  const expanded = expandTask(task);
  assert.equal(expanded.prompt, "from task");
});

// ---------------------------------------------------------------------------
// Template Expansion Evidence
// ---------------------------------------------------------------------------

test("buildTemplateExpansionEvidence produces correct digests", () => {
  const tpl: TaskTemplate = { id: "evidence-test", commands: ["echo ${VAR}"] };
  registerTemplate(tpl);
  const task: RunnerTask = {
    id: "ev-test",
    intent: "propose_patch",
    template: "evidence-test",
    templateVars: { VAR: "hello" },
  };
  const expanded = expandTask(task);
  const evidence = buildTemplateExpansionEvidence(task, expanded, tpl);
  assert.equal(evidence.schemaVersion, "a2a.runner.template-expansion.v1");
  assert.equal(evidence.templateId, "evidence-test");
  assert.deepEqual(evidence.varsProvided, ["VAR"]);
  assert.ok(evidence.preExpandDigest.length > 0);
  assert.ok(evidence.postExpandDigest.length > 0);
  assert.notEqual(evidence.preExpandDigest, evidence.postExpandDigest);
});

test("buildTemplateExpansionEvidence reports missing required vars", () => {
  const template: TaskTemplate = {
    id: "missing-vars",
    requiredVars: ["REQUIRED_ONE", "REQUIRED_TWO"],
    commands: ["echo ${REQUIRED_ONE} ${OPTIONAL}"],
  };
  registerTemplate(template);
  const task: RunnerTask = {
    id: "missing-test",
    intent: "propose_patch",
    template: "missing-vars",
    templateVars: { REQUIRED_ONE: "present" },
  };
  const expanded = expandTask(task);
  const evidence = buildTemplateExpansionEvidence(task, expanded, template);
  assert.ok(evidence.varsMissing);
  assert.deepEqual(evidence.varsMissing, ["REQUIRED_TWO"]);
});

// ---------------------------------------------------------------------------
// Terminal Brief Ops-Readiness Templates
// ---------------------------------------------------------------------------

test("terminal-brief-node-health is registered and retrievable", () => {
  const template = getTemplate("terminal-brief-node-health");
  assert.ok(template, "terminal-brief-node-health should be registered");
  assert.equal(template!.id, "terminal-brief-node-health");
  assert.equal(template!.version, "1.0.0");
  assert.equal(template!.mode, "github-propose-patch");
  assert.ok(template!.requiredVars);
  assert.ok(template!.requiredVars!.includes("EXPECTED_REVISION"));
  assert.ok(template!.requiredVars!.includes("TARGET_NODE"));
});

test("terminal-brief-latency-diagnostics is registered and retrievable", () => {
  const template = getTemplate("terminal-brief-latency-diagnostics");
  assert.ok(template, "terminal-brief-latency-diagnostics should be registered");
  assert.equal(template!.id, "terminal-brief-latency-diagnostics");
  assert.equal(template!.version, "1.0.0");
  assert.ok(template!.optionalVars);
  assert.equal(template!.optionalVars!["P95_THRESHOLD_MS"], "500");
});

test("terminal-brief-session-store-residue is registered and retrievable", () => {
  const template = getTemplate("terminal-brief-session-store-residue");
  assert.ok(template, "terminal-brief-session-store-residue should be registered");
  assert.equal(template!.id, "terminal-brief-session-store-residue");
  assert.equal(template!.version, "1.0.0");
  assert.ok(template!.env);
  assert.equal(template!.env!["A2A_DOCKER_RUNNER_NO_LIVE"], "1");
});

test("terminal-brief-worker-readiness is registered and retrievable", () => {
  const template = getTemplate("terminal-brief-worker-readiness");
  assert.ok(template, "terminal-brief-worker-readiness should be registered");
  assert.equal(template!.id, "terminal-brief-worker-readiness");
  assert.equal(template!.version, "1.0.0");
  assert.ok(template!.requiredVars);
  assert.ok(template!.requiredVars!.includes("EXPECTED_REVISION"));
  assert.ok(template!.requiredVars!.includes("TARGET_NODE"));
  assert.ok(template!.requiredVars!.includes("RUN_ID"));
});

test("all 4 terminal-brief templates are registered", () => {
  const ids = listTemplates().filter((id) => id.startsWith("terminal-brief-"));
  assert.equal(ids.length, 4);
  assert.ok(ids.includes("terminal-brief-node-health"));
  assert.ok(ids.includes("terminal-brief-latency-diagnostics"));
  assert.ok(ids.includes("terminal-brief-session-store-residue"));
  assert.ok(ids.includes("terminal-brief-worker-readiness"));
});

test("terminal-brief-node-health expansion produces evidence with vars expanded", () => {
  const task: RunnerTask = {
    id: "tb-node-health-run",
    intent: "propose_patch",
    template: "terminal-brief-node-health",
    templateVars: {
      DOCTOR_ARGS: "a2a-docker-runner doctor",
      EXPECTED_REVISION: "abc1234",
      TARGET_NODE: "nosuk",
    },
  };
  const expanded = expandTask(task);
  assert.ok(expanded);
  assert.equal(expanded.id, "tb-node-health-run");
  assert.equal(expanded.mode, "github-propose-patch");
  assert.ok(expanded.prompt);
  assert.ok(expanded.prompt!.includes("a2a-docker-runner doctor"));
  assert.ok(expanded.prompt!.includes("abc1234"));
  assert.ok(expanded.prompt!.includes("nosuk"));
  assert.equal(expanded.env!["A2A_DOCKER_RUNNER_NO_LIVE"], "1");

  const template = getTemplate("terminal-brief-node-health")!;
  const evidence = buildTemplateExpansionEvidence(task, expanded, template);
  assert.equal(evidence.templateId, "terminal-brief-node-health");
  assert.equal(evidence.templateVersion, "1.0.0");
  assert.deepEqual(evidence.varsProvided, ["DOCTOR_ARGS", "EXPECTED_REVISION", "TARGET_NODE"]);
  assert.ok(evidence.preExpandDigest);
  assert.ok(evidence.postExpandDigest);
  assert.notEqual(evidence.preExpandDigest, evidence.postExpandDigest);
});

test("terminal-brief-latency-diagnostics expansion produces evidence with vars", () => {
  const task: RunnerTask = {
    id: "tb-latency-run",
    intent: "propose_patch",
    template: "terminal-brief-latency-diagnostics",
    templateVars: {
      TARGET_NODE: "nosuk",
      RUN_ID: "a2a-r25-team1-ops-readiness-20260515T1656Z",
      P95_THRESHOLD_MS: "500",
      P99_THRESHOLD_MS: "500",
      SAMPLE_SIZE: "100",
      DIAGNOSTICS_SPLIT_CANDIDATES: "/health/diagnostics, /status",
    },
  };
  const expanded = expandTask(task);
  assert.ok(expanded);
  assert.ok(expanded.prompt!.includes("nosuk"));
  assert.ok(expanded.prompt!.includes("500ms"));
  assert.equal(expanded.env!["A2A_DOCKER_RUNNER_NO_LIVE"], "1");

  const template = getTemplate("terminal-brief-latency-diagnostics")!;
  const evidence = buildTemplateExpansionEvidence(task, expanded, template);
  assert.equal(evidence.templateId, "terminal-brief-latency-diagnostics");
  assert.equal(evidence.templateVersion, "1.0.0");
  assert.ok(evidence.varsProvided.includes("P95_THRESHOLD_MS"));
  assert.ok(evidence.varsProvided.includes("TARGET_NODE"));
  assert.ok(evidence.varsProvided.includes("RUN_ID"));
  assert.notEqual(evidence.preExpandDigest, evidence.postExpandDigest);
});

test("terminal-brief-worker-readiness expansion includes all required vars", () => {
  const task: RunnerTask = {
    id: "tb-readiness-run",
    intent: "propose_patch",
    template: "terminal-brief-worker-readiness",
    templateVars: {
      EXPECTED_REVISION: "abc1234",
      TARGET_NODE: "nosuk",
      RUN_ID: "a2a-r25-team1-ops-readiness-20260515T1656Z",
    },
  };
  const expanded = expandTask(task);
  assert.ok(expanded);
  assert.ok(expanded.prompt!.includes("abc1234"));
  assert.ok(expanded.prompt!.includes("nosuk"));
  assert.ok(expanded.prompt!.includes("terminal-brief-node-health"));
  assert.ok(expanded.prompt!.includes("terminal-brief-latency-diagnostics"));
  assert.ok(expanded.prompt!.includes("terminal-brief-session-store-residue"));

  const template = getTemplate("terminal-brief-worker-readiness")!;
  const evidence = buildTemplateExpansionEvidence(task, expanded, template);
  assert.equal(evidence.templateId, "terminal-brief-worker-readiness");
  assert.equal(evidence.templateVersion, "1.0.0");
  assert.ok(evidence.varsProvided.includes("EXPECTED_REVISION"));
  assert.ok(evidence.varsProvided.includes("TARGET_NODE"));
  assert.ok(evidence.varsProvided.includes("RUN_ID"));
  assert.notEqual(evidence.preExpandDigest, evidence.postExpandDigest);
});

test("terminal-brief templates produce no duplicate id errors on re-import", () => {
  // Re-registration should throw.
  assert.throws(() => {
    registerTemplate({ id: "terminal-brief-node-health", version: "2.0.0", label: "Dup" });
  }, /already registered/);
});
