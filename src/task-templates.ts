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

// ─── Built-in Template Registrations ──────────────────────────────────────

/**
 * A2A R24 OpenClaw all-node latency check template.
 *
 * Collects OpenClaw version, runtime diagnostics, health/ready status,
 * event-loop metrics, latency logs, session-store residue, A2A backlog,
 * and plugin/provider discovery drift.
 *
 * Target nodes: nosuk/vps2
 * Prerequisite: Node.js 22+ with `openclaw` available in PATH.
 * Safety: no restart, deploy, provider send, terminal ACK, or DB mutation.
 *
 * Parent: a2a-docker-runner#265
 * Parent: a2a-plane#343
 */
registerTemplate({
  id: "openclaw-latency-check",
  version: "1.0.0",
  label: "OpenClaw all-node latency check",
  mode: "github-propose-patch",
  requiredVars: ["TARGET_NODE"],
  optionalVars: {
    EVIDENCE_PREFIX: "latency-check",
  },
  commands: [
    // Step 1: Version and runtime
    'echo "=== OpenClaw Latency Check (A2A R24) ==="',
    'echo "Target node: ${TARGET_NODE}"',
    '',
    // Step 2: Status snapshot
    'openclaw --version 2>&1 | tee /work/artifacts/${EVIDENCE_PREFIX}-version.txt || echo "openclaw not in PATH"',
    'openclaw status 2>&1 | tee /work/artifacts/${EVIDENCE_PREFIX}-status.txt',
    '',
    // Step 3: Deep status probe
    'openclaw status --deep 2>&1 | tee /work/artifacts/${EVIDENCE_PREFIX}-deep-status.txt',
    '',
    // Step 4: Gateway health
    'openclaw gateway probe 2>&1 | tee /work/artifacts/${EVIDENCE_PREFIX}-gateway-probe.txt || echo "gateway probe failed (expected in sandbox)"',
    '',
    // Step 5: Session store inventory
    'ls -la ~/.openclaw/agents/main/sessions/ 2>&1 | tee /work/artifacts/${EVIDENCE_PREFIX}-sessions.txt || echo "no sessions dir"',
    '',
    // Step 6: Logs / event loop
    'openclaw logs 10 2>&1 | tee /work/artifacts/${EVIDENCE_PREFIX}-logs.txt || echo "no logs available"',
    '',
    // Step 7: Plugin/provider discovery
    'openclaw status --deep 2>&1 | grep -iE "provider|plugin|channel" | head -20 | tee /work/artifacts/${EVIDENCE_PREFIX}-providers.txt || echo "no provider info"',
    '',
    // Step 8: A2A backlog
    'cat /var/lib/openclaw-a2a/tasks/*/task.json 2>/dev/null | head -50 | tee /work/artifacts/${EVIDENCE_PREFIX}-backlog.txt || echo "no A2A backlog"',
    '',
    // Step 9: Build structured evidence
    'echo "Latency check artifacts collected"',
  ],
  prompt:
    "Collect OpenClaw latency and runtime diagnostics on target node ${TARGET_NODE}. " +
    "Run the latency check template commands, collect structured evidence, and report findings. " +
    "Do not restart Gateway/broker/worker, deploy, send provider messages, ACK terminal evidence, " +
    "or mutate production state.",
});
