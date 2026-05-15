/**
 * OpenClaw latency check collector (A2A R24).
 *
 * Collects OpenClaw runtime diagnostics: version, health/ready status,
 * event-loop metrics, latency logging, session-store residue, A2A backlog,
 * and plugin/provider discovery drift.
 *
 * Target nodes: nosuk/vps2
 * Parent: a2a-docker-runner#265
 * Parent: a2a-plane#343
 *
 * Safety: no Gateway/broker/worker restart, production deploy, live provider
 * send, terminal ACK, DB mutation, or destructive cleanup.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OpenClawLatencyCheck {
  schemaVersion: "a2a.runner.openclaw-latency-check.v1";
  /** Deterministic ISO timestamp. */
  generatedAt: string;
  /** Node identifier (e.g. nosuk, vps2). */
  node: string;
  /** Runtime host info from `openclaw status`. */
  runtime: {
    version: string;
    os: string;
    nodeVersion: string;
    gatewayReachable: boolean;
    gatewayUrl?: string;
    modelRoute: string;
    channel: string;
    agentCount: number;
  };
  /** Health/readiness/event-loop status snapshot. */
  health: {
    status: string;
    gatewayOk: boolean;
    agentSessions: number;
    memoryEnabled: boolean;
    heartbeatInterval: string;
    pluginCompatibility: string;
  };
  /** Recent latency probe results. */
  latencyLogs: {
    providerRoundTripMs?: number;
    gatewayConnectMs?: number;
    eventLoopLagMs?: number;
    notes: string[];
  };
  /** Session-store residue (stale sessions). */
  sessionStore: {
    sessionsDir: string;
    sessionCount: number;
    staleSessionCount: number;
    staleThresholdHours: number;
    staleSessions: string[];
  };
  /** A2A task backlog from the local session store. */
  a2aBacklog: {
    taskCount: number;
    tasks: string[];
  };
  /** Plugin/provider discovery drift. */
  pluginProviderDrift: {
    registryPlugins: string[];
    availableProviders: string[];
    driftNotes: string[];
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────

const OPENCLAW_BIN = "openclaw";
const SESSIONS_DIR = join(
  homedir(),
  ".openclaw",
  "agents",
  "main",
  "sessions",
);

const STALE_THRESHOLD_HOURS = 24;

const FIXED_TIMESTAMP = "1970-01-01T00:00:00.000Z";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Run a CLI command and return stdout, or empty string on failure. */
function safeExec(cmd: string, maxBuffer = 256 * 1024, timeoutMs = 10_000): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer,
    }).trim();
  } catch {
    return "";
  }
}

/** Parse a key=value or key: value line from status output. */
function parseKeyValue(
  lines: string[],
  key: string,
): string | undefined {
  for (const line of lines) {
    const stripped = line.replace(/^[│├└─┌│\s]+/, "").trim();
    const match = stripped.match(
      new RegExp(`^${escapeRegex(key)}\\s*[:=]\\s*(.+)$`),
    );
    if (match) return match[1].trim();
    // Table format: │ Key │ Value │
    const tableMatch = stripped.match(
      new RegExp(`^${escapeRegex(key)}\\s*│\\s*(.+?)\\s*│`),
    );
    if (tableMatch) return tableMatch[1].trim();
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count files in a directory (non-recursive). */
function countFiles(dir: string): number {
  try {
    const entries = readdirSync(dir);
    return entries.length;
  } catch {
    return 0;
  }
}

/** Get mtime age in hours. */
function ageHours(filePath: string): number {
  try {
    const st = statSync(filePath);
    return (Date.now() - st.mtimeMs) / 3600_000;
  } catch {
    return Infinity;
  }
}

function readdirSync(dir: string): string[] {
  try {
    const fs = require("node:fs");
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ─── Collection ────────────────────────────────────────────────────────────

/**
 * Collect OpenClaw latency and runtime diagnostics from the local environment.
 *
 * @param node - Node identifier for the check (e.g. "nosuk", "vps2").
 * @returns A structured latency check result.
 */
export function collectOpenClawLatencyCheck(node: string): OpenClawLatencyCheck {
  const statusOut = safeExec(`${OPENCLAW_BIN} status`, 256 * 1024, 8_000);
  // Deep probe uses shorter timeout; --deep may hang when gateway is unreachable
  const deepOut = safeExec(`${OPENCLAW_BIN} status --deep`, 512 * 1024, 6_000);
  const statusLines = statusOut.split("\n");
  const deepLines = deepOut.split("\n");

  // Runtime info
  const osLine = parseKeyValue(statusLines, "OS") ?? "";
  const versionLine = parseKeyValue(statusLines, "Channel") ?? "";
  const gatewayLine = parseKeyValue(statusLines, "Gateway") ?? "";
  const sessionsLine = parseKeyValue(statusLines, "Sessions") ?? "";
  const agentsLine = parseKeyValue(statusLines, "Agents") ?? "";
  const memoryLine = parseKeyValue(statusLines, "Memory") ?? "";
  const heartbeatLine = parseKeyValue(statusLines, "Heartbeat") ?? "";
  const pluginLine = parseKeyValue(statusLines, "Plugin compatibility") ?? "";

  // Model route from session info
  const modelMatch = sessionsLine.match(/(deepseek|gpt|claude|gemini|openclaw)[-\w.]+/i);
  const modelRoute = modelMatch?.[0] ?? "unknown";

  // Gateway reachable
  const gatewayReachable = !(gatewayLine.includes("unreachable") || gatewayLine.includes("unauthorized"));

  // Agent count
  const agentMatch = agentsLine.match(/^(\d+)/);
  const agentCount = agentMatch ? parseInt(agentMatch[1], 10) : 0;

  // Session count
  const sessionMatch = sessionsLine.match(/(\d+)\s+active/);
  const activeSessions = sessionMatch ? parseInt(sessionMatch[1], 10) : 0;

  // Memory enabled
  const memoryEnabled = memoryLine.includes("enabled");

  // Event loop lag
  const eventLoopLagLine = parseKeyValue(
    [...statusLines, ...deepLines],
    "Event loop lag",
  );
  const eventLoopLagMs = eventLoopLagLine
    ? parseFloat(eventLoopLagLine)
    : undefined;

  // Provider round-trip from deep status
  const providerRtLine = parseKeyValue(deepLines, "Provider round-trip");
  const providerRoundTripMs = providerRtLine
    ? parseFloat(providerRtLine)
    : undefined;

  // Gateway connect latency
  const gatewayConnectLine = parseKeyValue(
    [...statusLines, ...deepLines],
    "Gateway connect",
  );
  const gatewayConnectMs = gatewayConnectLine
    ? parseFloat(gatewayConnectLine)
    : undefined;

  // Latency notes
  const latencyNotes: string[] = [];
  if (!gatewayReachable) {
    latencyNotes.push("Gateway unreachable — latency probes reflect local diagnostics only");
  }
  if (eventLoopLagMs !== undefined && eventLoopLagMs > 100) {
    latencyNotes.push(`Event loop lag elevated: ${eventLoopLagMs}ms`);
  }
  if (providerRoundTripMs !== undefined) {
    latencyNotes.push(`Provider round-trip: ${providerRoundTripMs}ms`);
  }

  // Session-store residue
  const sessionCount = countFiles(SESSIONS_DIR);
  let staleSessions: string[] = [];
  try {
    const fs = require("node:fs");
    const entries = fs.readdirSync(SESSIONS_DIR);
    for (const entry of entries) {
      const fullPath = join(SESSIONS_DIR, entry);
      if (ageHours(fullPath) > STALE_THRESHOLD_HOURS) {
        staleSessions.push(entry);
      }
    }
  } catch {
    // sessions dir may not exist
  }

  // A2A task backlog from session store
  const backlogLines = deepOut
    .split("\n")
    .filter((l) => l.includes("task") || l.includes("Task") || l.includes("A2A"));
  const backlogTasks = backlogLines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);

  // Plugin/provider discovery drift
  const providerLines = deepOut
    .split("\n")
    .filter(
      (l) =>
        l.includes("provider") ||
        l.includes("Provider") ||
        l.includes("plugin") ||
        l.includes("Plugin"),
    );
  const availableProviders = [
    ...new Set(
      providerLines
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 10),
    ),
  ];

  return {
    schemaVersion: "a2a.runner.openclaw-latency-check.v1",
    generatedAt: FIXED_TIMESTAMP,
    node,
    runtime: {
      version: versionLine || safeExec(`${OPENCLAW_BIN} --version`),
      os: osLine,
      nodeVersion: process.version,
      gatewayReachable,
      gatewayUrl: gatewayReachable ? gatewayLine : undefined,
      modelRoute,
      channel: versionLine,
      agentCount,
    },
    health: {
      status: gatewayReachable ? "reachable" : "local_only",
      gatewayOk: gatewayReachable,
      agentSessions: activeSessions,
      memoryEnabled,
      heartbeatInterval: heartbeatLine,
      pluginCompatibility: pluginLine,
    },
    latencyLogs: {
      providerRoundTripMs,
      gatewayConnectMs,
      eventLoopLagMs,
      notes: latencyNotes,
    },
    sessionStore: {
      sessionsDir: SESSIONS_DIR,
      sessionCount,
      staleSessionCount: staleSessions.length,
      staleThresholdHours: STALE_THRESHOLD_HOURS,
      staleSessions,
    },
    a2aBacklog: {
      taskCount: backlogTasks.length,
      tasks: backlogTasks,
    },
    pluginProviderDrift: {
      registryPlugins: [],
      availableProviders,
      driftNotes: [],
    },
  };
}

/**
 * Serialize a latency check result into a markdown runbook summary.
 */
export function formatLatencyCheckRunbook(check: OpenClawLatencyCheck): string {
  const lines: string[] = [
    `# OpenClaw Latency Check — ${check.node}`,
    "",
    `Schema: ${check.schemaVersion}`,
    `Generated: ${check.generatedAt}`,
    "",
    "## Runtime",
    `- Version: ${check.runtime.version}`,
    `- OS: ${check.runtime.os}`,
    `- Node: ${check.runtime.nodeVersion}`,
    `- Model route: ${check.runtime.modelRoute}`,
    `- Gateway: ${check.runtime.gatewayReachable ? check.runtime.gatewayUrl : "unreachable"}`,
    `- Agents: ${check.runtime.agentCount}`,
    "",
    "## Health",
    `- Status: ${check.health.status}`,
    `- Sessions: ${check.health.agentSessions}`,
    `- Memory: ${check.health.memoryEnabled ? "enabled" : "disabled"}`,
    `- Heartbeat: ${check.health.heartbeatInterval}`,
    `- Plugins: ${check.health.pluginCompatibility}`,
    "",
    "## Latency",
    ...(check.latencyLogs.providerRoundTripMs !== undefined
      ? [`- Provider round-trip: ${check.latencyLogs.providerRoundTripMs}ms`]
      : ["- Provider round-trip: N/A"]),
    ...(check.latencyLogs.eventLoopLagMs !== undefined
      ? [`- Event loop lag: ${check.latencyLogs.eventLoopLagMs}ms`]
      : ["- Event loop lag: N/A"]),
    ...(check.latencyLogs.gatewayConnectMs !== undefined
      ? [`- Gateway connect: ${check.latencyLogs.gatewayConnectMs}ms`]
      : ["- Gateway connect: N/A"]),
    "",
    "### Notes",
    ...(check.latencyLogs.notes.length > 0
      ? check.latencyLogs.notes.map((n) => `- ${n}`)
      : ["- No latency anomalies detected"]),
    "",
    "## Session Store",
    `- Sessions dir: ${check.sessionStore.sessionsDir}`,
    `- Total sessions: ${check.sessionStore.sessionCount}`,
    `- Stale (>${check.sessionStore.staleThresholdHours}h): ${check.sessionStore.staleSessionCount}`,
    ...(check.sessionStore.staleSessions.length > 0
      ? ["", "### Stale Sessions", ...check.sessionStore.staleSessions.map((s) => `- ${s}`)]
      : []),
    "",
    "## A2A Backlog",
    ...(check.a2aBacklog.taskCount > 0
      ? [`- Tasks in backlog: ${check.a2aBacklog.taskCount}`]
      : ["- No A2A tasks in backlog"]),
    "",
    "## Plugin/Provider Discovery",
    ...(check.pluginProviderDrift.availableProviders.length > 0
      ? [
          "- Available providers:",
          ...check.pluginProviderDrift.availableProviders.map((p) => `  - ${p}`),
        ]
      : ["- No providers discovered (gateway may be unreachable)"]),
    "",
    "## Safety Declaration",
    "- No Gateway/broker/worker restart performed",
    "- No production deploy attempted",
    "- No live provider/Telegram canary executed",
    "- No DB mutation/prune/migration",
    "- No destructive cleanup",
  ];

  return lines.join("\n");
}
