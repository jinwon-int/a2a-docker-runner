#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const files = process.argv.slice(2);
const publicDemoFiles = files.length ? files : [
  "examples/artifact-manifest.dummy-task.json",
  "examples/runner-terminal-evidence-fixture.json",
  "examples/runner-telegram-terminal-notification-smoke.json",
  "examples/rollout-receipt-evidence.no-live.json",
];

const forbiddenPatterns = [
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "authorization header", pattern: /Authorization:\s*(?:Bearer|token)\s+\S+/i },
  { name: "secret assignment", pattern: /\b(?:token|password|secret|api[_-]?key)\s*=\s*(?!<redacted>|<placeholder>|synthetic-value)[^\s"']+/i },
  { name: "private home path", pattern: /(?:^|["'\s])(?:\/root\/|\/home\/[^\s"']+|\/Users\/[^\s"']+)/ },
  { name: "live Telegram target", pattern: /(?:chat[_-]?id|telegramTarget|target)\s*[:=]\s*["']?-?100\d{6,}/i },
  { name: "operator outbox ACK", pattern: /"terminalOutboxAck"\s*:\s*true|"providerSendOnlyAcknowledged"\s*:\s*true/i },
];

const denyListKeys = new Set(["mustNotContain", "safeEvidenceMustNotContain"]);

function collectScannableStrings(value, path = []) {
  if (typeof value === "string") return [{ path: path.join("."), value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectScannableStrings(entry, path.concat(String(index))));
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, entry]) => {
    if (denyListKeys.has(key)) return [];
    return collectScannableStrings(entry, path.concat(key));
  });
}

const failures = [];
for (const file of publicDemoFiles) {
  const path = resolve(repoRoot, file);
  const text = readFileSync(path, "utf8");
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(text); }, `${file} must be valid JSON`);

  for (const { path: jsonPath, value } of collectScannableStrings(parsed)) {
    for (const { name, pattern } of forbiddenPatterns) {
      if (pattern.test(value)) failures.push(`${file}:${jsonPath}: ${name}`);
    }
  }

  if (/"liveTelegramSend"\s*:\s*true/.test(text)) failures.push(`${file}: live Telegram send enabled`);
  if (/"productionDeploy"\s*:\s*true/.test(text)) failures.push(`${file}: production deploy enabled`);
  if (/"gatewayRestart"\s*:\s*true/.test(text)) failures.push(`${file}: Gateway restart enabled`);
  if (/"dbMutation"\s*:\s*true/.test(text)) failures.push(`${file}: DB mutation enabled`);
}

const result = {
  ok: failures.length === 0,
  schemaVersion: "a2a.runner.public-demo-safety-audit.v1",
  files: publicDemoFiles,
  checks: forbiddenPatterns.map((entry) => entry.name).concat([
    "valid JSON",
    "deny-list fields may name forbidden strings without failing the payload",
    "no production deploy/Gateway restart/live Telegram/DB mutation flags",
  ]),
  failures,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exit(1);
