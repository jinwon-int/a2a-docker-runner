import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SMOKE_TIMEOUT_MS, resolveSmokeTimeoutMs } from "./engine-smoke.js";

test("resolveSmokeTimeoutMs caps default runner timeout at gh-bootstrap-safe smoke bound", () => {
  assert.equal(DEFAULT_SMOKE_TIMEOUT_MS, 120_000);
  assert.equal(resolveSmokeTimeoutMs(45 * 60 * 1000), 120_000);
});

test("resolveSmokeTimeoutMs preserves explicit smaller smoke bounds", () => {
  assert.equal(resolveSmokeTimeoutMs(30_000), 30_000);
  assert.equal(resolveSmokeTimeoutMs(1_000), 1_000);
});

test("resolveSmokeTimeoutMs falls back to smoke bound for invalid config default", () => {
  assert.equal(resolveSmokeTimeoutMs(0), 120_000);
  assert.equal(resolveSmokeTimeoutMs(Number.NaN), 120_000);
});
