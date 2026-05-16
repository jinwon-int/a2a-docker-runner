/**
 * Tests for worker-capacity validation.
 *
 * Parent: a2a-plane#370
 */

import * as assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  validateWorkerCapacity,
  buildWorkerCapacityLimit,
  incrementInFlightTasks,
  decrementInFlightTasks,
  getInFlightTasks,
  resetInFlightTasks,
} from "./worker-capacity.js";

describe("buildWorkerCapacityLimit", () => {
  beforeEach(() => resetInFlightTasks());
  afterEach(() => resetInFlightTasks());

  it("uses default limit when maxConcurrentTasks is omitted", () => {
    const cap = buildWorkerCapacityLimit();
    assert.strictEqual(cap.maxConcurrentTasks, 10);
    assert.strictEqual(cap.currentLoad, 0);
    assert.strictEqual(cap.availableSlots, 10);
  });

  it("uses provided maxConcurrentTasks", () => {
    const cap = buildWorkerCapacityLimit(5);
    assert.strictEqual(cap.maxConcurrentTasks, 5);
    assert.strictEqual(cap.availableSlots, 5);
  });

  it("reflects current in-flight count", () => {
    incrementInFlightTasks();
    incrementInFlightTasks();
    const cap = buildWorkerCapacityLimit(5);
    assert.strictEqual(cap.currentLoad, 2);
    assert.strictEqual(cap.availableSlots, 3);
  });

  it("reports 0 available slots at capacity", () => {
    for (let i = 0; i < 10; i++) incrementInFlightTasks();
    const cap = buildWorkerCapacityLimit(10);
    assert.strictEqual(cap.currentLoad, 10);
    assert.strictEqual(cap.availableSlots, 0);
  });
});

describe("incrementInFlightTasks / decrementInFlightTasks", () => {
  beforeEach(() => resetInFlightTasks());
  afterEach(() => resetInFlightTasks());

  it("increments and decrements correctly", () => {
    assert.strictEqual(getInFlightTasks(), 0);
    incrementInFlightTasks();
    assert.strictEqual(getInFlightTasks(), 1);
    incrementInFlightTasks();
    incrementInFlightTasks();
    assert.strictEqual(getInFlightTasks(), 3);
    decrementInFlightTasks();
    assert.strictEqual(getInFlightTasks(), 2);
  });

  it("never goes below 0 on decrement", () => {
    decrementInFlightTasks();
    assert.strictEqual(getInFlightTasks(), 0);
    decrementInFlightTasks();
    assert.strictEqual(getInFlightTasks(), 0);
  });
});

describe("validateWorkerCapacity", () => {
  beforeEach(() => resetInFlightTasks());
  afterEach(() => resetInFlightTasks());

  it("returns ok:true when no constraints are violated (default capacity)", () => {
    const result = validateWorkerCapacity("worker-1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.worker, "worker-1");
    assert.strictEqual(result.capacity?.maxConcurrentTasks, 10);
    assert.strictEqual(result.capacity?.currentLoad, 0);
    assert.strictEqual(result.errors, undefined);
  });

  it("returns ok:true when parentRoundOrder <= parentRoundTotal", () => {
    const result = validateWorkerCapacity("worker-1", 2, 5);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors, undefined);
  });

  it("returns ok:true when worker has available slots", () => {
    const result = validateWorkerCapacity("worker-1", 1, 5, { maxConcurrentTasks: 5, currentLoad: 2, availableSlots: 3 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors, undefined);
  });

  it("returns ok:false with error when parentRoundOrder exceeds parentRoundTotal", () => {
    const result = validateWorkerCapacity("worker-1", 6, 5);
    assert.strictEqual(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors![0].includes("parentRoundOrder (6) exceeds parentRoundTotal (5)"));
  });

  it("returns ok:false with error when worker is at capacity", () => {
    const result = validateWorkerCapacity("worker-1", 1, 3, { maxConcurrentTasks: 3, currentLoad: 3, availableSlots: 0 });
    assert.strictEqual(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors![0].includes("at capacity"));
    assert.ok(result.errors![0].includes("3/3"));
  });

  it("reports both errors when multiple constraints fail", () => {
    const result = validateWorkerCapacity("worker-1", 10, 5, { maxConcurrentTasks: 2, currentLoad: 2, availableSlots: 0 });
    assert.strictEqual(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.strictEqual(result.errors!.length, 2);
    assert.ok(result.errors![0].includes("parentRoundOrder"));
    assert.ok(result.errors![1].includes("at capacity"));
  });

  it("uses default capacity when limit not provided and in-flight is 0", () => {
    const result = validateWorkerCapacity("worker-1");
    assert.strictEqual(result.capacity?.maxConcurrentTasks, 10);
    assert.strictEqual(result.capacity?.currentLoad, 0);
    assert.strictEqual(result.capacity?.availableSlots, 10);
  });

  it("uses default capacity with current in-flight count when limit not provided", () => {
    incrementInFlightTasks();
    incrementInFlightTasks();
    incrementInFlightTasks();
    const result = validateWorkerCapacity("worker-1");
    assert.strictEqual(result.capacity?.maxConcurrentTasks, 10);
    assert.strictEqual(result.capacity?.currentLoad, 3);
    assert.strictEqual(result.capacity?.availableSlots, 7);
  });

  it("returns ok:false when default capacity is exceeded by in-flight tasks", () => {
    for (let i = 0; i < 10; i++) incrementInFlightTasks();
    const result = validateWorkerCapacity("worker-1");
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors![0].includes("at capacity"));
    assert.ok(result.errors![0].includes("10/10"));
  });

  it("produces valid schema version", () => {
    const result = validateWorkerCapacity("test-worker");
    assert.strictEqual(result.schemaVersion, "a2a.runner.worker-capacity.v1");
  });

  it("passes through partial round info (order only, no total)", () => {
    const result = validateWorkerCapacity("worker-1", 3);
    // When parentRoundTotal is missing, we can't validate order vs total
    assert.strictEqual(result.ok, true);
  });

  it("passes through partial round info (total only, no order)", () => {
    const result = validateWorkerCapacity("worker-1", undefined, 5);
    // When parentRoundOrder is missing, we can't validate order vs total
    assert.strictEqual(result.ok, true);
  });
});
