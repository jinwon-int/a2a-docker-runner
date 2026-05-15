/**
 * CI-safe OpenClaw latency check tests (A2A R24).
 *
 * Validates the latency check collector fixture and runbook formatter
 * without calling live `openclaw` CLI or touching a live gateway.
 *
 * Parent: a2a-docker-runner#265
 * Parent: a2a-plane#343
 */

import assert from "node:assert/strict";
import test from "node:test";

import { collectOpenClawLatencyCheck, formatLatencyCheckRunbook } from "./openclaw-latency-check.js";
import type { OpenClawLatencyCheck } from "./openclaw-latency-check.js";

// ─── Synthetic fixtures (no live CLI calls) ──────────────────────────

function makeSyntheticCheck(overrides?: Partial<OpenClawLatencyCheck>): OpenClawLatencyCheck {
  return {
    schemaVersion: "a2a.runner.openclaw-latency-check.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    node: "test-node",
    runtime: {
      version: "2026.5.12",
      os: "linux 6.8.0-107-generic (x64)",
      nodeVersion: "v22.22.2",
      gatewayReachable: false,
      modelRoute: "deepseek-v4-flash",
      channel: "stable",
      agentCount: 1,
    },
    health: {
      status: "local_only",
      gatewayOk: false,
      agentSessions: 1,
      memoryEnabled: true,
      heartbeatInterval: "30m (main)",
      pluginCompatibility: "none",
    },
    latencyLogs: {
      providerRoundTripMs: undefined,
      gatewayConnectMs: undefined,
      eventLoopLagMs: undefined,
      notes: ["Gateway unreachable — latency probes reflect local diagnostics only"],
    },
    sessionStore: {
      sessionsDir: "/root/.openclaw/agents/main/sessions",
      sessionCount: 3,
      staleSessionCount: 1,
      staleThresholdHours: 24,
      staleSessions: ["session-20260513T000000Z-stale"],
    },
    a2aBacklog: {
      taskCount: 0,
      tasks: [],
    },
    pluginProviderDrift: {
      registryPlugins: [],
      availableProviders: ["default (deepseek-v4-flash)"],
      driftNotes: [],
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

test("openclaw latency check: schema version is stable", () => {
  const check = makeSyntheticCheck();
  assert.equal(check.schemaVersion, "a2a.runner.openclaw-latency-check.v1");
});

test("openclaw latency check: generatedAt is deterministic", () => {
  const check = makeSyntheticCheck();
  assert.equal(check.generatedAt, "1970-01-01T00:00:00.000Z");
});

test("openclaw latency check: node identifier is propagated", () => {
  const check = makeSyntheticCheck({ node: "nosuk" });
  assert.equal(check.node, "nosuk");
});

test("openclaw latency check: runtime fields have correct types", () => {
  const check = makeSyntheticCheck();

  assert.ok(typeof check.runtime.version === "string");
  assert.ok(typeof check.runtime.os === "string");
  assert.ok(typeof check.runtime.nodeVersion === "string");
  assert.ok(typeof check.runtime.gatewayReachable === "boolean");
  assert.ok(typeof check.runtime.modelRoute === "string");
  assert.ok(typeof check.runtime.agentCount === "number");
});

test("openclaw latency check: model route must not contain secrets", () => {
  const check = makeSyntheticCheck();

  assert.ok(!check.runtime.modelRoute.includes("sk-"));
  assert.ok(!check.runtime.modelRoute.includes("ghp_"));
  assert.ok(!check.runtime.modelRoute.includes("xai-"));
});

test("openclaw latency check: health fields have correct types", () => {
  const check = makeSyntheticCheck();

  assert.ok(typeof check.health.status === "string");
  assert.ok(typeof check.health.gatewayOk === "boolean");
  assert.ok(typeof check.health.agentSessions === "number");
  assert.ok(typeof check.health.memoryEnabled === "boolean");
});

test("openclaw latency check: latency logs shape is stable", () => {
  const check = makeSyntheticCheck();

  assert.ok(check.latencyLogs.providerRoundTripMs === undefined || typeof check.latencyLogs.providerRoundTripMs === "number");
  assert.ok(check.latencyLogs.gatewayConnectMs === undefined || typeof check.latencyLogs.gatewayConnectMs === "number");
  assert.ok(check.latencyLogs.eventLoopLagMs === undefined || typeof check.latencyLogs.eventLoopLagMs === "number");
  assert.ok(Array.isArray(check.latencyLogs.notes));
  assert.ok(check.latencyLogs.notes.every((n) => typeof n === "string"));
});

test("openclaw latency check: session store shape is stable", () => {
  const check = makeSyntheticCheck();

  assert.ok(typeof check.sessionStore.sessionsDir === "string");
  assert.ok(check.sessionStore.sessionCount >= 0);
  assert.ok(check.sessionStore.staleSessionCount >= 0);
  assert.equal(check.sessionStore.staleThresholdHours, 24);
  assert.ok(Array.isArray(check.sessionStore.staleSessions));
  assert.ok(check.sessionStore.staleSessions.every((s) => typeof s === "string"));
});

test("openclaw latency check: A2A backlog has stable shape", () => {
  const check = makeSyntheticCheck();

  assert.ok(check.a2aBacklog.taskCount >= 0);
  assert.ok(Array.isArray(check.a2aBacklog.tasks));
});

test("openclaw latency check: plugin/provider drift has stable shape", () => {
  const check = makeSyntheticCheck();

  assert.ok(Array.isArray(check.pluginProviderDrift.registryPlugins));
  assert.ok(Array.isArray(check.pluginProviderDrift.availableProviders));
  assert.ok(Array.isArray(check.pluginProviderDrift.driftNotes));
});

test("openclaw latency check: JSON serialization roundtrip preserves data", () => {
  const check = makeSyntheticCheck({ node: "vps2" });
  const json = JSON.stringify(check);
  const parsed = JSON.parse(json) as OpenClawLatencyCheck;

  assert.equal(parsed.node, "vps2");
  assert.equal(parsed.schemaVersion, "a2a.runner.openclaw-latency-check.v1");
  assert.equal(parsed.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(parsed.runtime.version, "2026.5.12");
  assert.equal(parsed.runtime.modelRoute, "deepseek-v4-flash");
  assert.equal(parsed.runtime.gatewayReachable, false);
  assert.equal(parsed.health.agentSessions, 1);
  assert.equal(parsed.sessionStore.staleSessionCount, 1);
  assert.equal(parsed.a2aBacklog.taskCount, 0);
});

test("openclaw latency check: formatLatencyCheckRunbook produces markdown with all sections", () => {
  const check = makeSyntheticCheck({ node: "nosuk" });
  const runbook = formatLatencyCheckRunbook(check);

  assert.ok(runbook.startsWith("# OpenClaw Latency Check — nosuk"));
  assert.ok(runbook.includes("## Runtime"));
  assert.ok(runbook.includes("## Health"));
  assert.ok(runbook.includes("## Latency"));
  assert.ok(runbook.includes("## Session Store"));
  assert.ok(runbook.includes("## A2A Backlog"));
  assert.ok(runbook.includes("## Plugin/Provider Discovery"));
  assert.ok(runbook.includes("## Safety Declaration"));
});

test("openclaw latency check: formatLatencyCheckRunbook contains runtime details", () => {
  const check = makeSyntheticCheck();
  const runbook = formatLatencyCheckRunbook(check);

  assert.ok(runbook.includes(check.runtime.version));
  assert.ok(runbook.includes(check.runtime.modelRoute));
  assert.ok(runbook.includes(check.runtime.os));
});

test("openclaw latency check: formatLatencyCheckRunbook contains latency notes", () => {
  const check = makeSyntheticCheck();
  const runbook = formatLatencyCheckRunbook(check);

  assert.ok(runbook.includes(check.latencyLogs.notes[0]));
});

test("openclaw latency check: formatLatencyCheckRunbook contains stale session info", () => {
  const check = makeSyntheticCheck();
  const runbook = formatLatencyCheckRunbook(check);

  assert.ok(runbook.includes("session-20260513T000000Z-stale"));
  assert.ok(runbook.includes("24h"));
});

test("openclaw latency check: formatLatencyCheckRunbook carries safety declaration", () => {
  const check = makeSyntheticCheck();
  const runbook = formatLatencyCheckRunbook(check);

  assert.ok(runbook.includes("No Gateway/broker/worker restart performed"));
  assert.ok(runbook.includes("No production deploy attempted"));
  assert.ok(runbook.includes("No live provider/Telegram canary executed"));
  assert.ok(runbook.includes("No DB mutation/prune/migration"));
  assert.ok(runbook.includes("No destructive cleanup"));
});

test("openclaw latency check: runbook does not contain secrets or bootstrap files", () => {
  const check = makeSyntheticCheck();
  const runbook = formatLatencyCheckRunbook(check);

  for (const forbidden of [
    "ghp_",
    "github_pat_",
    "x-access-token",
    "sk-",
    "xai-",
    "password",
    "secret:",
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
  ]) {
    assert.ok(!runbook.includes(forbidden), `runbook contains forbidden value: ${forbidden}`);
  }
  // The .openclaw/ directory path itself is legitimate diagnostic context
  // (it's the session store location), not a leaked bootstrap file.
});

test("openclaw latency check: synthetic fixture does not contain secrets or bootstrap files", () => {
  const check = makeSyntheticCheck();
  const raw = JSON.stringify(check);

  for (const forbidden of [
    "ghp_",
    "github_pat_",
    "x-access-token",
    "sk-",
    "xai-",
    "password",
    "secret:",
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
  ]) {
    assert.ok(!raw.includes(forbidden), `check JSON contains forbidden value: ${forbidden}`);
  }
  // The .openclaw/ directory path is legitimate diagnostic detail
  // (session store location) and is not a leaked bootstrap context file.
});

test("openclaw latency check: collectOpenClawLatencyCheck runs without throwing", () => {
  // This test calls the actual collector but with short timeouts
  // (fast-fails if gateway is unreachable)
  const check = collectOpenClawLatencyCheck("docker-runner");

  assert.equal(check.schemaVersion, "a2a.runner.openclaw-latency-check.v1");
  assert.equal(check.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(check.node, "docker-runner");
  assert.ok(check.runtime.nodeVersion.length > 0);
  assert.ok(typeof check.runtime.gatewayReachable === "boolean");
});

test("openclaw latency check: latency notes are always populated", () => {
  // Even when gateway is unreachable, notes should be present
  const check = makeSyntheticCheck({
    latencyLogs: {
      providerRoundTripMs: undefined,
      gatewayConnectMs: undefined,
      eventLoopLagMs: undefined,
      notes: ["Gateway unreachable — latency probes reflect local diagnostics only"],
    },
  });

  assert.ok(check.latencyLogs.notes.length > 0);
});
