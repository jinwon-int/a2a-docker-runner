/**
 * Worker-capacity validation for the runner.
 *
 * Validates that worker capacity limits and round-level constraints are met
 * before/after task execution. Returns structured WorkerCapacityEvidence that
 * the broker uses for terminal-ack decisioning and operator dashboards.
 *
 * Parent: a2a-plane#370
 * Parent: a2a-docker-runner#370
 */

import type { WorkerCapacityEvidence, WorkerCapacityLimit } from "./types.js";

/**
 * Default capacity limit used when none is supplied by the worker.
 * A conservative default prevents runaway concurrency in unconfigured workers.
 */
const DEFAULT_MAX_CONCURRENT_TASKS = 10;

/**
 * The runner's current in-flight task count.
 *
 * In a container runner this always reflects the local runner process, not
 * the entire broker pool. For accurate cluster-wide capacity, the caller
 * should supply an explicit {@link WorkerCapacityLimit}.
 */
let currentInFlightTasks = 0;

/**
 * Increment the in-flight task counter.
 *
 * Call this when a task begins execution to track local runner capacity.
 */
export function incrementInFlightTasks(): void {
  currentInFlightTasks += 1;
}

/**
 * Decrement the in-flight task counter.
 *
 * Call this when a task completes (success, failure, or timeout) to release
 * a capacity slot.
 */
export function decrementInFlightTasks(): void {
  currentInFlightTasks = Math.max(0, currentInFlightTasks - 1);
}

/**
 * Return the current in-flight task count.
 *
 * Used for diagnostics and testing; do not rely on the raw value for
 * capacity decisions when an explicit limit is configured.
 */
export function getInFlightTasks(): number {
  return currentInFlightTasks;
}

/**
 * Reset the in-flight task counter (for testing).
 */
export function resetInFlightTasks(): void {
  currentInFlightTasks = 0;
}

/**
 * Build a {@link WorkerCapacityLimit} from optional worker-provided capacity
 * and the local runner's in-flight task count.
 *
 * When `maxConcurrentTasks` is omitted, the default limit (10) is used.
 */
export function buildWorkerCapacityLimit(maxConcurrentTasks?: number): WorkerCapacityLimit {
  const limit = maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  const currentLoad = currentInFlightTasks;
  return {
    maxConcurrentTasks: limit,
    currentLoad,
    availableSlots: Math.max(0, limit - currentLoad),
  };
}

/**
 * Validate worker capacity constraints for a task.
 *
 * Returns a {@link WorkerCapacityEvidence} with `ok: true` when the worker's
 * stated capacity is sufficient.  Produces error messages when:
 *
 * - `parentRoundOrder > parentRoundTotal` (the task's position in its parent
 *   round exceeds the round size)
 * - `currentLoad >= maxConcurrentTasks` (the worker is at or over capacity)
 *
 * @param worker   Worker identity string (from `requestedBy` or equivalent).
 * @param parentRoundOrder 1-based position of this task in its parent round.
 * @param parentRoundTotal Total tasks in the parent round.
 * @param capacityLimit    Optional explicit capacity limit; uses default when
 *                         omitted.
 */
export function validateWorkerCapacity(
  worker: string,
  parentRoundOrder?: number,
  parentRoundTotal?: number,
  capacityLimit?: WorkerCapacityLimit,
): WorkerCapacityEvidence {
  const errors: string[] = [];

  // ── Round-level integrity check ──
  if (parentRoundOrder != null && parentRoundTotal != null) {
    if (parentRoundOrder > parentRoundTotal) {
      errors.push(
        `parentRoundOrder (${parentRoundOrder}) exceeds parentRoundTotal (${parentRoundTotal})`,
      );
    }
  }

  // ── Capacity-limit check ──
  const cap = capacityLimit ?? buildWorkerCapacityLimit();
  if (cap.currentLoad >= cap.maxConcurrentTasks) {
    errors.push(
      `worker at capacity: ${cap.currentLoad}/${cap.maxConcurrentTasks} tasks in flight (available: ${cap.availableSlots})`,
    );
  }

  return {
    schemaVersion: "a2a.runner.worker-capacity.v1",
    ok: errors.length === 0,
    worker,
    capacity: cap,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
