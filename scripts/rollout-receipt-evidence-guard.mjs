#!/usr/bin/env node
import { readFileSync } from "node:fs";

const ACTIVE_WORKERS = ["bangtong", "dungae", "sogyo", "nosuk"];

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/rollout-receipt-evidence-guard.mjs --input <merged-evidence.json> --expected-commit <sha> [--workers bangtong,dungae,sogyo,nosuk]\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { workers: ACTIVE_WORKERS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--expected-commit") args.expectedCommit = argv[++i];
    else if (arg === "--workers") args.workers = argv[++i]?.split(",").map((w) => w.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.input || !args.expectedCommit || !args.workers?.length) usage();
  return args;
}

function normalizeWorkers(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.workers)) return raw.workers;
  if (raw?.workers && typeof raw.workers === "object") {
    return Object.entries(raw.workers).map(([name, value]) => ({ worker: name, ...(value && typeof value === "object" ? value : {}) }));
  }
  throw new Error("merged evidence must contain a workers array or workers object");
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isPassingTest(value) {
  if (!value || typeof value !== "object") return false;
  if (value.ok === true || value.passed === true) return true;
  return ["pass", "passed", "ok", "success", "succeeded"].includes(String(value.status ?? "").toLowerCase());
}

function operatorReceiptPresent(value) {
  if (!value || typeof value !== "object") return false;
  if (value.operatorVisible !== true && value.operatorVisibleReceipt !== true) return false;
  return Boolean(value.receiptId || value.messageId || value.url || value.receiptUrl || value.deliveredAt || value.receivedAt);
}

function providerSendOnlyRejected(value) {
  if (!value || typeof value !== "object") return false;
  if (value.providerSendOnlyAcknowledged === true || value.providerSendOnlyAck === true) return false;
  if (value.providerSendOnly?.acknowledged === true || value.providerSendOnly?.cursorComplete === true) return false;
  if (value.providerSendOnly?.ack === true) return false;
  return true;
}

function staleBacklogClear(value) {
  if (!value || typeof value !== "object") return false;
  if (value.noStaleBacklogTerminalReceipts === true) return true;
  if (value.staleBacklog?.count === 0 || value.staleBacklogTerminalReceipts === 0) return true;
  if (Array.isArray(value.staleBacklogTerminalReceipts) && value.staleBacklogTerminalReceipts.length === 0) return true;
  return false;
}

function validateWorker(entry, worker, expectedCommit) {
  const errors = [];
  const revision = pickString(
    entry.runnerBuild?.revision,
    entry.runnerBuild?.commit,
    entry.artifact?.revision,
    entry.artifact?.commit,
    entry.revision,
    entry.commit,
  );
  const version = pickString(entry.runnerBuild?.version, entry.artifact?.version, entry.version);

  if (!revision) errors.push("missing runner artifact revision/commit");
  else if (revision !== expectedCommit) errors.push(`runner artifact commit ${revision} does not match expected ${expectedCommit}`);
  if (!version) errors.push("missing runner artifact version");
  if (!isPassingTest(entry.focusedTest ?? entry.test ?? entry.focusedTestResult)) errors.push("focused test result is missing or not passing");
  if (!operatorReceiptPresent(entry.receiptSmoke ?? entry.terminalReceiptSmoke ?? entry.ackSmoke)) errors.push("operator-visible terminal receipt evidence is missing");
  if (!providerSendOnlyRejected(entry.receiptSmoke ?? entry.terminalReceiptSmoke ?? entry.ackSmoke)) errors.push("provider-send-only ACK evidence would complete the cursor");
  if (!staleBacklogClear(entry)) errors.push("no stale-backlog terminal receipt evidence was not proven");

  return { worker, ok: errors.length === 0, errors, revision, version };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(args.input, "utf8"));
  const entries = normalizeWorkers(raw);
  const byWorker = new Map(entries.map((entry) => [pickString(entry.worker, entry.name, entry.node), entry]));

  const results = args.workers.map((worker) => {
    const entry = byWorker.get(worker);
    if (!entry) return { worker, ok: false, errors: ["missing worker evidence"] };
    return validateWorker(entry, worker, args.expectedCommit);
  });

  const ok = results.every((result) => result.ok);
  const output = {
    schemaVersion: "a2a.runner.rollout-receipt-evidence-guard.v1",
    ok,
    expectedCommit: args.expectedCommit,
    workers: results,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!ok) process.exit(1);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
