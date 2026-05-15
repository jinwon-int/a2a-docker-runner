// ─────────────────────────────────────────────────────────────────────────────
// Task Templates (Team1 nosuk lane, A2A R23)
// Parent: a2a-docker-runner#261
// Parent: a2a-plane#335
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type {
  RunnerTask,
  TaskTemplate,
  TaskTemplateVars,
  TemplateExpansionEvidence,
  NormalizedRunnerTask,
} from "./types.js";

// ─── Built-in Template Registry ─────────────────────────────────────────

/**
 * Built-in template registry.
 *
 * Templates are keyed by id.  The runner resolves `task.template` against
 * this registry before falling back to `task.inlineTemplate`.
 */
const BUILTIN_TEMPLATES: Map<string, TaskTemplate> = new Map();

/**
 * Register a built-in template at import time.
 * Throws on duplicate id.
 */
export function registerTemplate(template: TaskTemplate): void {
  if (BUILTIN_TEMPLATES.has(template.id)) {
    throw new Error(`Template "${template.id}" is already registered`);
  }
  BUILTIN_TEMPLATES.set(template.id, template);
}

/**
 * Look up a template by id from the built-in registry.
 */
export function getTemplate(id: string): TaskTemplate | undefined {
  return BUILTIN_TEMPLATES.get(id);
}

/**
 * List all registered template ids.
 */
export function listTemplates(): string[] {
  return [...BUILTIN_TEMPLATES.keys()];
}

// ─── Template Resolution ────────────────────────────────────────────────

/**
 * Resolve a template reference from a task.
 *
 * Priority:
 * 1. `task.template` → lookup in built-in registry
 * 2. `task.inlineTemplate` → use directly
 *
 * Returns undefined if no template is configured.
 */
export function resolveTemplate(task: RunnerTask): TaskTemplate | undefined {
  if (task.template) {
    const builtin = BUILTIN_TEMPLATES.get(task.template);
    if (builtin) return builtin;
    // If there's an inline template with a matching id, fall through.
    if (task.inlineTemplate?.id === task.template) return task.inlineTemplate;
    // Template name not found — caller should handle this as an error.
    return undefined;
  }
  if (task.inlineTemplate) return task.inlineTemplate;
  return undefined;
}

// ─── Variable Expansion ─────────────────────────────────────────────────

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expand `${variable}` placeholders in a string using the provided vars map.
 *
 * Missing variables are left unexpanded (preserved as-is) so that callers
 * can detect them.
 */
export function expandVars(template: string, vars: TaskTemplateVars): string {
  return template.replace(VAR_PATTERN, (match, name: string) => {
    return name in vars ? vars[name] : match;
  });
}

/**
 * Detect missing required variables after expansion.
 */
export function findMissingVars(template: string, required: string[]): string[] {
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_PATTERN.source, "g");
  while ((m = re.exec(template)) !== null) {
    used.add(m[1]);
  }
  return required.filter((name) => used.has(name) && !BUILTIN_TEMPLATES.has(name));
}

// ─── Task Expansion ─────────────────────────────────────────────────────

/**
 * Expand a template into a task, returning a new task with template fields
 * merged and `${variable}` placeholders substituted.
 *
 * Strategy (merged by priority, lowest→highest):
 *   template defaults < task fields
 *
 * Merge rules:
 * - `commands`: template commands come first, task commands append
 * - `prompt`: task prompt wins; template prompt used as fallback
 * - `env`: template env is base, task env overrides
 * - `repos`: template repos come first, task repos append.  Duplicate
 *   URLs are deduped (first wins).
 * - `mode`, `preset`, `baseBranch`, `reportLanguage`, `timeoutMs`: task
 *   values override template values (template used as fallback)
 *
 * @returns The expanded task (a shallow copy with expanded fields).
 * @throws If the template reference cannot be resolved.
 */
export function expandTask(task: RunnerTask): RunnerTask {
  const template = resolveTemplate(task);
  if (!template) {
    if (task.template && !task.inlineTemplate) {
      throw new Error(`Template "${task.template}" not found in registry or inline`);
    }
    // No template configured — return the task unchanged.
    return { ...task };
  }

  const vars = task.templateVars ?? {};

  // Helper: expand env entries.
  const expandEnv = (env: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!env) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      result[key] = expandVars(value, vars);
    }
    return result;
  };

  // Helper: expand commands array.
  const expandCommands = (cmds: string[] | undefined): string[] | undefined => {
    if (!cmds) return undefined;
    return cmds.map((cmd) => expandVars(cmd, vars));
  };

  // Merge repos: template repos first, then task repos (deduped by URL).
  const mergedRepos = mergeRepos(template.repos, task.repos);

  // Merge commands: template commands expanded first, then task commands appended.
  const templateCommands = expandCommands(template.commands) ?? [];
  const taskCommands = task.commands ?? [];
  const mergedCommands = [...templateCommands, ...taskCommands];

  // Merge env: template env expanded as base, task env overrides.
  const mergedEnv = {
    ...expandEnv(template.env),
    ...task.env,
  };

  return {
    ...task,
    // Fields where template provides fallback.
    mode: task.mode ?? template.mode,
    preset: task.preset ?? (template.preset as RunnerTask["preset"]),
    baseBranch: task.baseBranch ?? template.baseBranch,
    reportLanguage: task.reportLanguage ?? template.reportLanguage,
    timeoutMs: task.timeoutMs ?? template.timeoutMs,
    // Commands (merged).
    commands: mergedCommands,
    // Prompt: task prompt wins.
    prompt: task.prompt ?? (expandVars(template.prompt ?? "", vars) || undefined),
    // Repos (merged + deduped).
    repos: mergedRepos,
    // Env (merged).
    env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
  };
}

function mergeRepos(templateRepos: RunnerTask["repos"], taskRepos: RunnerTask["repos"]): RunnerTask["repos"] {
  const seen = new Set<string>();
  const merged: NonNullable<RunnerTask["repos"]> = [];

  for (const repo of [...(templateRepos ?? []), ...(taskRepos ?? [])]) {
    const url = typeof repo === "string" ? repo : repo.url ?? "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    merged.push(repo);
  }

  return merged.length > 0 ? merged : undefined;
}

// ─── Evidence Computation ───────────────────────────────────────────────

/**
 * Build template expansion evidence from a task and its expanded version.
 *
 * Computes digests of the task shape before and after expansion using a
 * deterministic JSON serialisation (sorted keys, no whitespace).
 */
export function buildTemplateExpansionEvidence(
  task: RunnerTask,
  expanded: RunnerTask,
  template: TaskTemplate,
): TemplateExpansionEvidence {
  const preDigest = sha256Json(task);
  const postDigest = sha256Json(expanded);
  const vars = task.templateVars ?? {};
  const varsProvided = Object.keys(vars);
  const required = template.requiredVars ?? [];
  const hasMissing = (required.some((r) => !(r in vars)));
  const optional = template.optionalVars ? Object.keys(template.optionalVars) : [];

  return {
    schemaVersion: "a2a.runner.template-expansion.v1",
    templateId: template.id,
    templateVersion: template.version,
    varsProvided,
    ...(hasMissing ? { varsMissing: required.filter((r) => !(r in vars)) } : {}),
    ...(optional.length > 0 ? { varsOptional: optional } : {}),
    preExpandDigest: preDigest,
    postExpandDigest: postDigest,
  };
}

/**
 * Compute a deterministic sha256 hex digest of a JSON-serialisable value.
 */
export function sha256Json(value: unknown): string {
  const json = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
  return createHash("sha256").update(json).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in Terminal Brief Ops-Readiness Templates (Team1 nosuk lane, A2A R25)
// Parent: a2a-docker-runner#270
// Parent: a2a-plane#351
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register all built-in templates at import time.
 */
(function registerBuiltinTemplates(): void {
  // ── Node Health ──────────────────────────────────────────────────────────
  // Pre/post Terminal Brief activation: runner node health check.
  // No-live: no provider sends, Gateway restart, DB mutation, terminal ACK.
  registerTemplate({
    id: "terminal-brief-node-health",
    version: "1.0.0",
    label: "Terminal Brief Node Health Check",
    mode: "github-propose-patch",
    prompt: [
      "You are Team1/Seoseo operations checking node health before or after Terminal Brief activation.",
      "",
      "Perform these no-live checks on the a2a-docker-runner checkout:",
      "",
      "1. ✅ Run `${DOCTOR_ARGS}` to validate engine (docker/podman), task root, secret mount, base image.",
      "2. ✅ Run `node scripts/deploy-marker-doctor.mjs --expected-revision ${EXPECTED_REVISION}` to confirm deploy marker.",
      "3. ✅ Verify the doctor report shows no failures (all checks pass).",
      "4. ✅ Verify deploy marker matches the expected revision or produce Block evidence if it does not.",
      "5. ✅ Confirm no provider send, Gateway/broker restart, DB mutation, or terminal ACK was performed.",
      "",
      "Safety gates:",
      "- Do not restart Gateway, broker, or worker processes.",
      "- Do not send live provider messages or ACK terminal outboxes.",
      "- Do not mutate production databases.",
      "- Do not change repository visibility or publish releases.",
      "- Do not push, merge, or create PRs; this is a verification-only task.",
      "",
      "Target node: ${TARGET_NODE}",
    ].join("\n"),
    requiredVars: ["DOCTOR_ARGS", "EXPECTED_REVISION", "TARGET_NODE"],
    optionalVars: {
      DOCTOR_ARGS: "a2a-docker-runner doctor",
    },
    env: {
      A2A_DOCKER_RUNNER_NO_LIVE: "1",
    },
  });

  // ── Latency Diagnostics ──────────────────────────────────────────────────
  // Pre/post Terminal Brief activation: latency threshold diagnostics.
  registerTemplate({
    id: "terminal-brief-latency-diagnostics",
    version: "1.0.0",
    label: "Terminal Brief Latency Diagnostics",
    mode: "github-propose-patch",
    prompt: [
      "You are Team1/Seoseo operations running latency diagnostics before or after Terminal Brief activation.",
      "",
      "Perform these no-live checks on the a2a-docker-runner checkout:",
      "",
      "1. ✅ Validate latency thresholds: p95 <= ${P95_THRESHOLD_MS}ms, p99 <= ${P99_THRESHOLD_MS}ms over ${SAMPLE_SIZE} samples.",
      "2. ✅ Verify repeated-latency diagnostic stages are present: persistenceSummary, hotEntityMirrorCounts, auditDiagnostics, requestPressure, jsonSerialization.",
      "3. ✅ Confirm expensive diagnostics are cached or split (no live /health calls to a broker).",
      "4. ✅ Verify diagnostics split candidates include ${DIAGNOSTICS_SPLIT_CANDIDATES}.",
      "5. ✅ Report Block evidence if any threshold or diagnostic stage is missing or out of range.",
      "6. ✅ Confirm no live broker /health calls, Gateway restart, provider send, DB mutation, or terminal ACK.",
      "",
      "This check is fixture/synthetic-only: it MUST NOT call a live broker endpoint.",
      "",
      "Safety gates:",
      "- Do not restart Gateway, broker, or worker processes.",
      "- Do not send live provider messages or ACK terminal outboxes.",
      "- Do not mutate production databases.",
      "- No live /health calls to a broker endpoint.",
      "",
      "Target node: ${TARGET_NODE}",
      "Context run: ${RUN_ID}",
    ].join("\n"),
    requiredVars: ["TARGET_NODE", "RUN_ID"],
    optionalVars: {
      P95_THRESHOLD_MS: "500",
      P99_THRESHOLD_MS: "500",
      SAMPLE_SIZE: "100",
      DIAGNOSTICS_SPLIT_CANDIDATES: "/health/diagnostics, /status",
    },
    env: {
      A2A_DOCKER_RUNNER_NO_LIVE: "1",
    },
  });

  // ── Session-Store Residue ───────────────────────────────────────────────
  registerTemplate({
    id: "terminal-brief-session-store-residue",
    version: "1.0.0",
    label: "Terminal Brief Session-Store Residue Check",
    mode: "github-propose-patch",
    prompt: [
      "You are Team1/Seoseo operations checking OpenClaw session-store residue before or after Terminal Brief activation.",
      "",
      "Perform these no-live checks on the a2a-docker-runner checkout:",
      "",
      "1. ✅ Verify session store guard detects empty active-agent registries (${ACTIVE_AGENT_ID} sessions.json is not empty).",
      "2. ✅ Verify session backup count (${MAX_BACKUP_COUNT}) is not exceeded.",
      "3. ✅ Verify session backup bytes (${MAX_BACKUP_BYTES}) is not exceeded.",
      "4. ✅ Report Block evidence if session store guard would block execution.",
      "5. ✅ Confirm cleanup rehearsal runs without errors (dry-run mode).",
      "6. ✅ Confirm no live provider send, Gateway restart, DB mutation, or terminal ACK.",
      "",
      "The session-store guard is embedded in the OpenClaw patch profile at src/config.ts; this template",
      "validates that the guard triggers correctly without touching a live host session store.",
      "",
      "Safety gates:",
      "- Do not restart Gateway, broker, or worker processes.",
      "- Do not send live provider messages or ACK terminal outboxes.",
      "- Do not mutate production databases.",
      "- Do not copy or upload host session-store files.",
      "",
      "Target node: ${TARGET_NODE}",
    ].join("\n"),
    requiredVars: ["TARGET_NODE"],
    optionalVars: {
      ACTIVE_AGENT_ID: "main",
      MAX_BACKUP_COUNT: "50",
      MAX_BACKUP_BYTES: "134217728",
    },
    env: {
      A2A_DOCKER_RUNNER_NO_LIVE: "1",
    },
  });

  // ── Worker Readiness ────────────────────────────────────────────────────
  // Pre/post Terminal Brief activation: full worker readiness gate.
  registerTemplate({
    id: "terminal-brief-worker-readiness",
    version: "1.0.0",
    label: "Terminal Brief Worker Readiness Gate",
    mode: "github-propose-patch",
    prompt: [
      "You are Team1/Seoseo operations running the full worker readiness gate before or after Terminal Brief activation.",
      "",
      "Perform these no-live checks on the a2a-docker-runner checkout:",
      "",
      "1. ✅ Run the node health check (template: terminal-brief-node-health).",
      "2. ✅ Run the latency diagnostics check (template: terminal-brief-latency-diagnostics).",
      "3. ✅ Run the session-store residue check (template: terminal-brief-session-store-residue).",
      "4. ✅ Run `a2a-docker-runner doctor` and confirm all checks pass.",
      "5. ✅ Run `node scripts/deploy-marker-doctor.mjs --expected-revision ${EXPECTED_REVISION}`.",
      "6. ✅ Verify runner evidence contract: log, test, diff, file evidence kinds work.",
      "7. ✅ Verify the worker has no stale backlog or pending unhealthy runs.",
      "8. ✅ Report Block evidence if ANY check fails; report Done evidence only if ALL pass.",
      "9. ✅ Confirm no live provider send, Gateway restart, DB mutation, or terminal ACK.",
      "",
      "This is the final readiness gate. All sub-checks must pass before Terminal Brief activation.",
      "This template must NOT perform: deployment, restart, canary send, DB prune, or release.",
      "",
      "Safety gates:",
      "- Do not restart Gateway, broker, or worker processes.",
      "- Do not send live provider messages or ACK terminal outboxes.",
      "- Do not mutate production databases.",
      "- Do not push, merge, or create PRs; this is a verification-only task.",
      "- Do not change repository visibility, publish releases, or tag commits.",
      "",
      "Target node: ${TARGET_NODE}",
      "Context run: ${RUN_ID}",
    ].join("\n"),
    requiredVars: ["EXPECTED_REVISION", "TARGET_NODE", "RUN_ID"],
    env: {
      A2A_DOCKER_RUNNER_NO_LIVE: "1",
    },
  });
})();
