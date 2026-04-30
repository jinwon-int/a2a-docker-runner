/**
 * CI-safe broker canary payload conversion test (Round 4 rollout prep).
 *
 * Validates that the broker-canary-round4.json fixture converts correctly
 * through buildRunnerTaskFromHandlerPayload without touching live broker,
 * Docker, or GitHub.
 *
 * Coverage:
 * - Valid JSON example parses without error
 * - buildRunnerTaskFromHandlerPayload produces correct RunnerTask fields
 * - Active target nodes (bangtong/dungae/sogyo/nosuk) are present
 * - Yukson is explicitly excluded
 * - Timeout, reportLanguage, issueUrl, mode are preserved
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildRunnerTaskFromHandlerPayload,
  isEnvTruthy,
  shouldUseDockerRunnerForGithub,
} from "./integration.js";
import type { HandlerTask, HandlerEnv } from "./integration.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CanaryPayload {
  canary: {
    mode?: string;
    requestedBy?: string;
    repo?: string;
    baseBranch?: string;
    issue?: string;
    issueNumber?: string;
    issueUrl?: string;
    title?: string;
    focus?: string;
    acceptance?: string;
    activeTargets?: string[];
    excludeNodes?: string[];
    reportLanguage?: string;
    timeoutMs?: number;
    runnerPreset?: string | null;
    prompt?: string;
  };
  evidenceGuide?: Record<string, string>;
  operatorChecklist?: string[];
  excludedLegacy?: {
    reason?: string;
    action?: string;
  };
}

function loadCanaryPayload(): CanaryPayload {
  const raw = readFileSync(
    join(__dirname, "..", "examples", "broker-canary-round4.json"),
    "utf8",
  );
  return JSON.parse(raw) as CanaryPayload;
}

const baseEnv: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1" };

// ═══════════════════════════════════════════════════════════════════════════
// Payload validation
// ═══════════════════════════════════════════════════════════════════════════

test("broker canary payload is valid JSON and parses", () => {
  const payload = loadCanaryPayload();
  assert.ok(payload, "payload should parse");
  assert.ok(payload.canary, "payload should have canary section");
  assert.ok(payload.evidenceGuide, "payload should have evidence guide");
  assert.ok(payload.operatorChecklist, "payload should have operator checklist");
  assert.ok(payload.excludedLegacy, "payload should have excluded legacy section");
});

test("broker canary payload has active targets (bangtong/dungae/sogyo/nosuk)", () => {
  const payload = loadCanaryPayload();
  const targets = payload.canary.activeTargets ?? [];
  assert.ok(targets.includes("bangtong"), "missing bangtong");
  assert.ok(targets.includes("dungae"), "missing dungae");
  assert.ok(targets.includes("sogyo"), "missing sogyo");
  assert.ok(targets.includes("nosuk"), "missing nosuk");
});

test("broker canary payload explicitly excludes yukson", () => {
  const payload = loadCanaryPayload();
  const excludes = payload.canary.excludeNodes ?? [];
  assert.ok(excludes.includes("yukson"), "yukson must be in excludeNodes");
  assert.ok(
    typeof payload.excludedLegacy?.reason === "string" &&
      payload.excludedLegacy.reason.length > 0,
    "excludedLegacy.reason must be present",
  );
});

test("broker canary payload evidence guide covers PR/Done/Block", () => {
  const payload = loadCanaryPayload();
  const guide = payload.evidenceGuide ?? {};
  assert.ok(typeof guide.prUrl === "string" && guide.prUrl.length > 0, "missing prUrl guide");
  assert.ok(
    typeof guide.doneCommentUrl === "string" && guide.doneCommentUrl.length > 0,
    "missing doneCommentUrl guide",
  );
  assert.ok(
    typeof guide.blockCommentUrl === "string" && guide.blockCommentUrl.length > 0,
    "missing blockCommentUrl guide",
  );
  assert.ok(
    typeof guide.noEvidence === "string" && guide.noEvidence.length > 0,
    "missing noEvidence guide",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// buildRunnerTaskFromHandlerPayload conversion
// ═══════════════════════════════════════════════════════════════════════════

test("converts broker canary payload to valid RunnerTask", () => {
  const payload = loadCanaryPayload();
  const p = payload.canary;

  const handlerTask: HandlerTask = {
    id: "canary-round4-001",
    intent: "propose_patch",
    payload: {
      mode: p.mode ?? "github-propose-patch",
      repo: p.repo,
      baseBranch: p.baseBranch,
      issue: p.issue,
      issueNumber: p.issueNumber,
      issueUrl: p.issueUrl,
      title: p.title,
      focus: p.focus,
      acceptance: p.acceptance,
      prompt: p.prompt,
      timeoutMs: p.timeoutMs,
    },
  };

  const env: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: String(p.timeoutMs),
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, env);

  assert.equal(runnerTask.mode, "github-propose-patch");
  assert.equal(runnerTask.repo, "jinwon-int/a2a-docker-runner");
  assert.equal(runnerTask.baseBranch, "main");
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/30");
  assert.equal(runnerTask.reportLanguage, "ko");
  assert.equal(runnerTask.timeoutMs, 300000);

  // Runner task id should be derived from handler task id
  assert.ok(typeof runnerTask.id === "string" && runnerTask.id.length > 0);
  assert.ok(runnerTask.id.includes("canary-round4"));
});

test("builds RunnerTask with issueUrl fallback from issueNumber", () => {
  const payload = loadCanaryPayload();

  // Test with issueNumber but no explicit issueUrl
  const handlerTask: HandlerTask = {
    id: "canary-issue-fallback",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: payload.canary.repo,
      baseBranch: "main",
      issueNumber: "30",
    },
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);

  // issueUrl should be constructed from repo + issueNumber
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/30");
});

test("builds RunnerTask with issueUrl fallback from issue with # prefix", () => {
  const handlerTask: HandlerTask = {
    id: "canary-hash-issue",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
      baseBranch: "main",
      issue: "#30",
    },
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/30");
});

test("respects explicit issueUrl over constructed fallback", () => {
  const handlerTask: HandlerTask = {
    id: "canary-explicit-url",
    intent: "propose_patch",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
      baseBranch: "main",
      issue: "#30",
      issueUrl: "https://github.com/jinwon-int/a2a-docker-runner/issues/30",
    },
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  assert.equal(runnerTask.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/30");
});

test("timeoutMs from env A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS takes precedence", () => {
  const handlerTask: HandlerTask = {
    id: "canary-timeout-prec",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
      timeoutMs: 60000,
    },
  };

  const env: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: "180000",
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, env);
  assert.equal(runnerTask.timeoutMs, 180000, "env timeout should override payload timeout");
});

test("default timeoutMs is 45 minutes when no override", () => {
  const handlerTask: HandlerTask = {
    id: "canary-default-timeout",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
    },
  };

  const runnerTask = buildRunnerTaskFromHandlerPayload(handlerTask, baseEnv);
  assert.equal(runnerTask.timeoutMs, 45 * 60 * 1000);
});

// ═══════════════════════════════════════════════════════════════════════════
// shouldUseDockerRunnerForGithub with canary payload
// ═══════════════════════════════════════════════════════════════════════════

test("shouldUseDockerRunnerForGithub routes canary payload when ENABLED + ALL_GITHUB", () => {
  const handlerTask: HandlerTask = {
    id: "canary-route",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
    },
  };

  const env: HandlerEnv = {
    A2A_DOCKER_RUNNER_ENABLED: "1",
    A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
  };

  assert.equal(shouldUseDockerRunnerForGithub(handlerTask, env), true);
});

test("shouldUseDockerRunnerForGithub does not route canary payload without ALL_GITHUB or matching preset", () => {
  const handlerTask: HandlerTask = {
    id: "canary-no-route",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
    },
  };

  // ENABLED but no ALL_GITHUB and no matching preset → should not route
  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "1" };
  assert.equal(shouldUseDockerRunnerForGithub(handlerTask, env), false);
});

test("shouldUseDockerRunnerForGithub returns false when ENABLED=0", () => {
  const handlerTask: HandlerTask = {
    id: "canary-disabled",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-docker-runner",
    },
  };

  const env: HandlerEnv = { A2A_DOCKER_RUNNER_ENABLED: "0" };
  assert.equal(shouldUseDockerRunnerForGithub(handlerTask, env), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// isEnvTruthy edge cases
// ═══════════════════════════════════════════════════════════════════════════

test("isEnvTruthy recognises all accepted truthy values", () => {
  assert.equal(isEnvTruthy("1"), true);
  assert.equal(isEnvTruthy("true"), true);
  assert.equal(isEnvTruthy("yes"), true);
  assert.equal(isEnvTruthy("on"), true);
  assert.equal(isEnvTruthy("TRUE"), true);
  assert.equal(isEnvTruthy("YES"), true);

  assert.equal(isEnvTruthy("0"), false);
  assert.equal(isEnvTruthy("false"), false);
  assert.equal(isEnvTruthy(""), false);
  assert.equal(isEnvTruthy(undefined), false);
  assert.equal(isEnvTruthy("maybe"), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Operator checklist validation
// ═══════════════════════════════════════════════════════════════════════════

test("broker canary payload operator checklist covers all required steps", () => {
  const payload = loadCanaryPayload();
  const checklist = payload.operatorChecklist ?? [];
  assert.ok(checklist.length >= 3, "checklist should have at least 3 steps");

  const fullText = checklist.join("\n");
  // Step 1: canary payload test
  assert.ok(fullText.includes("canary-payload.test"), "missing canary-payload test step");
  // Step 2: full canary test
  assert.ok(fullText.includes("canary.test"), "missing full canary test step");
  // Step 3: npm checks
  assert.ok(fullText.includes("npm"), "missing npm check step");
  // Step 4: active targets
  assert.ok(fullText.includes("bangtong"), "missing bangtong in checklist");
  assert.ok(fullText.includes("dungae"), "missing dungae in checklist");
  assert.ok(fullText.includes("sogyo"), "missing sogyo in checklist");
  assert.ok(fullText.includes("nosuk"), "missing nosuk in checklist");
  // Step 5: yukson exclusion
  assert.ok(fullText.includes("yukson"), "missing yukson exclusion in checklist");
});

test("broker canary payload uses synthetic values only (no real secrets)", () => {
  const raw = readFileSync(
    join(__dirname, "..", "examples", "broker-canary-round4.json"),
    "utf8",
  );
  // Must not contain real token patterns
  assert.ok(!raw.includes("ghp" + "_"), "should not contain real GitHub tokens");
  assert.ok(!raw.includes("github" + "_pat" + "_"), "should not contain fine-grained PATs");
  assert.ok(!raw.includes("sk-"), "should not contain API keys");
  assert.ok(!raw.includes("x-access-token"), "should not contain access tokens");
  assert.ok(!raw.includes("xai-"), "should not contain xai tokens");
  assert.ok(!raw.includes("/root/"), "should not contain private filesystem paths");
  assert.ok(!raw.includes("/home/"), "should not contain user home paths");
  assert.ok(!raw.includes("password"), "should not contain password strings");
  assert.ok(!raw.includes("secret:"), "should not contain secret values");
});
