/**
 * Tests for the R31 worker capacity probe.
 *
 * Covers:
 * - Probe produces valid WorkerCapacityEvidence matching the plane schema.
 * - Per-subsystem detail is populated with bounded, non-secret data.
 * - Degradation when subsystems are unavailable (no docker, no rootDir).
 * - Deterministic output when nowMs is supplied.
 * - Probe is read-only (no side effects in test).
 *
 * Parent: a2a-docker-runner#291
 * Parent: a2a-plane#380
 */

import assert from "node:assert/strict";
import test from "node:test";
import { probeWorkerCapacity } from "./worker-capacity-probe.js";
import type { PressureClass, PreferredLaneSize, WorkerCapacityProbeResult } from "./worker-capacity-probe.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema structure
// ─────────────────────────────────────────────────────────────────────────────

test("probeWorkerCapacity returns a complete probe result with evidence", async () => {
  const result = await probeWorkerCapacity({ rootDir: undefined });

  // Top-level structure
  assert.ok(result, "result should be defined");
  assert.ok(typeof result.cpu === "object", "cpu should be an object");
  assert.ok(typeof result.memory === "object", "memory should be an object");
  assert.ok(typeof result.disk === "object", "disk should be an object");
  assert.ok(typeof result.docker === "object", "docker should be an object");
  assert.ok(typeof result.processes === "object", "processes should be an object");
  assert.ok(typeof result.taskHistory === "object", "taskHistory should be an object");
  assert.ok(Array.isArray(result.errors), "errors should be an array");
  assert.ok(typeof result.evidence === "object", "evidence should be an object");
});

test("evidence has correct schema version", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(result.evidence.schemaVersion, "a2a.runner.worker-capacity-evidence.v1");
});

test("evidence uses supplied deterministic timestamp", async () => {
  const result = await probeWorkerCapacity({ nowMs: 0 });
  assert.equal(result.evidence.probedAt, "1970-01-01T00:00:00.000Z");
  assert.match(result.evidence.capacity.probedAt ?? "", /^1970-01-01/);
});

test("evidence uses current time by default", async () => {
  const before = Date.now();
  const result = await probeWorkerCapacity();
  const after = Date.now();
  const observed = Date.parse(result.evidence.probedAt);

  assert.ok(observed >= before, "probedAt should be current, got " + result.evidence.probedAt);
  assert.ok(observed <= after, "probedAt should be current, got " + result.evidence.probedAt);
  assert.equal(result.evidence.capacity.probedAt, result.evidence.probedAt);
});

test("evidence declares scheduling metadata safety gates", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(result.evidence.isSchedulingMetadataOnly, true);
  assert.equal(result.evidence.terminalAckDecisionFromCapacity, false);
});

test("evidence workerId defaults to hostname", async () => {
  const result = await probeWorkerCapacity();
  assert.ok(typeof result.evidence.workerId === "string", "workerId should be a string");
  assert.ok(result.evidence.workerId.length > 0, "workerId should not be empty");
});

test("evidence capacity.known is true", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(result.evidence.capacity.known, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// CPU
// ─────────────────────────────────────────────────────────────────────────────

test("cpu probe returns cores and architecture", async () => {
  const result = await probeWorkerCapacity();

  assert.ok(Number.isInteger(result.cpu.cores), `cpu.cores should be an integer, got ${result.cpu.cores}`);
  assert.ok(result.cpu.cores >= 1, `cpu.cores should be >= 1, got ${result.cpu.cores}`);
  assert.ok(typeof result.cpu.architecture === "string", "cpu.architecture should be a string");
  assert.ok(
    ["x64", "arm64", "aarch64", "arm", "s390x", "ppc64"].includes(result.cpu.architecture) ||
      result.cpu.architecture.startsWith("x86") ||
      result.cpu.architecture.startsWith("arm") ||
      result.cpu.architecture.startsWith("riscv"),
    `cpu.architecture should be a known arch, got ${result.cpu.architecture}`,
  );
});

test("cpu cores is reflected in evidence.capacity.cpuCores", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(result.evidence.capacity.cpuCores, result.cpu.cores);
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

test("memory probe returns total and available bytes", async () => {
  const result = await probeWorkerCapacity();

  assert.ok(typeof result.memory.totalBytes === "number", "memory.totalBytes should be a number");
  assert.ok(typeof result.memory.availableBytes === "number", "memory.availableBytes should be a number");
  assert.ok(result.memory.totalBytes > 0, "memory.totalBytes should be > 0");
  assert.ok(
    result.memory.availableBytes <= result.memory.totalBytes,
    "availableBytes should not exceed totalBytes",
  );
});

test("memory pressure class is a valid value", async () => {
  const result = await probeWorkerCapacity();
  const validClasses: PressureClass[] = ["low", "moderate", "high", "unknown"];
  assert.ok(validClasses.includes(result.memory.pressureClass), `invalid pressure class: ${result.memory.pressureClass}`);
});

test("memory values are reflected in evidence.capacity", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(result.evidence.capacity.memoryTotalBytes, result.memory.totalBytes);
  assert.equal(result.evidence.capacity.memoryAvailableBytes, result.memory.availableBytes);
});

// ─────────────────────────────────────────────────────────────────────────────
// Disk
// ─────────────────────────────────────────────────────────────────────────────

test("disk probe returns total and free bytes", async () => {
  const result = await probeWorkerCapacity();

  assert.ok(typeof result.disk.totalBytes === "number", "disk.totalBytes should be a number");
  assert.ok(typeof result.disk.freeBytes === "number", "disk.freeBytes should be a number");
});

test("disk pressure class is a valid value", async () => {
  const result = await probeWorkerCapacity();
  const validClasses: PressureClass[] = ["low", "moderate", "high", "unknown"];
  assert.ok(validClasses.includes(result.disk.pressureClass), `invalid disk pressure class: ${result.disk.pressureClass}`);
});

test("disk free bytes is reflected in evidence.capacity.diskFreeBytes", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(result.evidence.capacity.diskFreeBytes, result.disk.freeBytes);
});

// ─────────────────────────────────────────────────────────────────────────────
// Docker
// ─────────────────────────────────────────────────────────────────────────────

test("docker probe available is a boolean", async () => {
  const result = await probeWorkerCapacity();
  assert.equal(typeof result.docker.available, "boolean");
});

test("docker storage driver is string or undefined", async () => {
  const result = await probeWorkerCapacity();
  if (result.docker.storageDriver !== undefined) {
    assert.ok(typeof result.docker.storageDriver === "string");
  }
});

test("docker disk pressure is valid or undefined", async () => {
  const result = await probeWorkerCapacity();
  if (result.docker.diskPressure !== undefined) {
    const validClasses: PressureClass[] = ["low", "moderate", "high", "unknown"];
    assert.ok(validClasses.includes(result.docker.diskPressure!), `invalid docker disk pressure: ${result.docker.diskPressure}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Process health
// ─────────────────────────────────────────────────────────────────────────────

test("process health values are valid", async () => {
  const result = await probeWorkerCapacity();
  const validHealth: string[] = ["healthy", "degraded", "unavailable", "unknown"];
  assert.ok(validHealth.includes(result.processes.openclawHealth), `invalid openclaw health: ${result.processes.openclawHealth}`);
  assert.ok(validHealth.includes(result.processes.a2aWorkerHealth), `invalid a2a worker health: ${result.processes.a2aWorkerHealth}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Task history (when no rootDir is given)
// ─────────────────────────────────────────────────────────────────────────────

test("task history defaults to empty when rootDir is not set", async () => {
  const result = await probeWorkerCapacity();

  assert.equal(result.taskHistory.recentTaskCount, 0);
  assert.deepEqual(result.taskHistory.recentTaskRuntimesMs, []);
  assert.equal(result.taskHistory.recentTimeoutCount, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Preferred lane size
// ─────────────────────────────────────────────────────────────────────────────

test("preferredLaneSize is a valid value", async () => {
  const result = await probeWorkerCapacity();
  const validSizes: PreferredLaneSize[] = ["small", "medium", "large", "unknown"];
  const size = result.evidence.capacity.preferredLaneSize;
  if (size !== undefined) {
    assert.ok(validSizes.includes(size as PreferredLaneSize), `invalid lane size: ${size}`);
  }
});

test("schedulingHint is a string", async () => {
  const result = await probeWorkerCapacity();
  assert.ok(typeof result.evidence.capacity.schedulingHint === "string");
  assert.ok(result.evidence.capacity.schedulingHint!.length > 0, "schedulingHint should not be empty");
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety: no secrets, no large payloads
// ─────────────────────────────────────────────────────────────────────────────

test("probe result contains no GitHub tokens or secrets", async () => {
  const result = await probeWorkerCapacity();
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes("ghp_"), "should not contain GitHub PAT prefix");
  assert.ok(!serialized.includes("gho_"), "should not contain GitHub OAuth prefix");
  assert.ok(!serialized.includes("github_pat_"), "should not contain GitHub fine-grained PAT prefix");
  assert.ok(!serialized.includes("ghu_"), "should not contain GitHub user token prefix");
  assert.ok(!serialized.includes("ghs_"), "should not contain GitHub server token prefix");
  assert.ok(!serialized.includes("x-access-token"), "should not contain access token hint");
});

test("probe result is bounded (under 16KB)", async () => {
  const result = await probeWorkerCapacity();
  const serialized = JSON.stringify(result);
  assert.ok(
    serialized.length < 16_384,
    `probe result should be under 16KB, got ${serialized.length} bytes`,
  );
});

test("probe result does not contain absolute host paths", async () => {
  const result = await probeWorkerCapacity();
  const serialized = JSON.stringify(result);
  // Check for common private host path patterns.
  assert.ok(!serialized.includes("/home/"), "should not contain /home/ paths");
  assert.ok(!serialized.includes("/root/"), "should not contain /root/ paths");
  assert.ok(!serialized.includes("/tmp/"), "should not contain /tmp/ paths");
  assert.ok(!serialized.includes("/var/lib/"), "should not contain /var/lib/ paths");
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

test("probe is deterministic: same options produce same output shape", async () => {
  const result1 = await probeWorkerCapacity({ workerId: "det-test", nowMs: 0 });
  const result2 = await probeWorkerCapacity({ workerId: "det-test", nowMs: 0 });

  assert.equal(result1.evidence.workerId, result2.evidence.workerId);
  assert.equal(result1.evidence.probedAt, result2.evidence.probedAt);
  assert.equal(result1.evidence.capacity.known, result2.evidence.capacity.known);
  assert.equal(result1.evidence.capacity.cpuCores, result2.evidence.capacity.cpuCores);

  // CPU cores and arch should be stable within same run context.
  assert.equal(result1.cpu.cores, result2.cpu.cores);
  assert.equal(result1.cpu.architecture, result2.cpu.architecture);
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom workerId
// ─────────────────────────────────────────────────────────────────────────────

test("custom workerId is reflected in evidence", async () => {
  const result = await probeWorkerCapacity({ workerId: "my-custom-worker-42" });
  assert.equal(result.evidence.workerId, "my-custom-worker-42");
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge: errors array is always present
// ─────────────────────────────────────────────────────────────────────────────

test("errors array is never null or undefined", async () => {
  const result = await probeWorkerCapacity();
  assert.ok(Array.isArray(result.errors));
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe runs without throwing
// ─────────────────────────────────────────────────────────────────────────────

test("probeWorkerCapacity never throws", async () => {
  // Should succeed even without rootDir.
  let result: WorkerCapacityProbeResult | undefined;
  let threw = false;
  try {
    result = await probeWorkerCapacity({ rootDir: "/tmp/nonexistent-a2a-probe-test" });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "probeWorkerCapacity should never throw");
  assert.ok(result, "result should be defined even with nonexistent rootDir");
});

test("probeWorkerCapacity with existing rootDir does not throw", async () => {
  let result: WorkerCapacityProbeResult | undefined;
  let threw = false;
  try {
    result = await probeWorkerCapacity({ rootDir: "/tmp" });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "probeWorkerCapacity with /tmp should not throw");
  assert.ok(result, "result should be defined");
});
