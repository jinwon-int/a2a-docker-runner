#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const startedAt = new Date().toISOString();
const args = parseArgs(process.argv.slice(2));
const mode = args.real ? "real" : "mock";
const timeoutMs = Number(args.timeoutMs ?? process.env.A2A_CHAOS_TIMEOUT_MS ?? 30_000);
const outputPath = args.output ? resolve(String(args.output)) : undefined;
const workDir = args.workDir ? resolve(String(args.workDir)) : await mkdtemp(resolve(tmpdir(), "a2a-chaos-e2e-"));

const scenarioDefinitions = [
  {
    name: "broker_restart",
    description: "submit work, restart broker, and verify the task still completes exactly once",
    realSteps: ["submitTask", "brokerRestart", "waitResult", "assertNoDuplicateCompletion"],
    mock: async (ctx) => {
      const taskId = ctx.submitTask("broker-restart");
      ctx.restartBroker();
      ctx.workerTick();
      ctx.completeTask(taskId);
      ctx.assertCompletedOnce(taskId);
    }
  },
  {
    name: "worker_kill",
    description: "kill the active worker during a claim and verify another worker can complete the task",
    realSteps: ["submitTask", "workerKill", "workerStart", "waitResult", "assertNoDuplicateCompletion"],
    mock: async (ctx) => {
      const taskId = ctx.submitTask("worker-kill");
      ctx.claimTask(taskId, "worker-a");
      ctx.killWorker("worker-a");
      ctx.workerTick("worker-b");
      ctx.completeTask(taskId, "worker-b");
      ctx.assertCompletedOnce(taskId);
    }
  },
  {
    name: "stale_requeue",
    description: "create a stale claim and verify the broker requeues it before completion",
    realSteps: ["submitTask", "workerKill", "requeueStale", "workerStart", "waitResult"],
    mock: async (ctx) => {
      const taskId = ctx.submitTask("stale-requeue");
      ctx.claimTask(taskId, "worker-a");
      ctx.markStale(taskId);
      ctx.requeueStale();
      ctx.workerTick("worker-b");
      ctx.completeTask(taskId, "worker-b");
      ctx.assertEvent(taskId, "requeued_stale");
    }
  },
  {
    name: "duplicate_delivery_tolerance",
    description: "inject duplicate delivery/completion attempts and verify idempotent task evidence",
    realSteps: ["submitTask", "injectDuplicate", "waitResult", "assertNoDuplicateCompletion"],
    mock: async (ctx) => {
      const taskId = ctx.submitTask("duplicate-delivery");
      ctx.claimTask(taskId, "worker-a");
      ctx.injectDuplicate(taskId);
      ctx.completeTask(taskId, "worker-a");
      ctx.completeTask(taskId, "worker-b");
      ctx.assertCompletedOnce(taskId);
      ctx.assertEvent(taskId, "duplicate_ignored");
    }
  },
  {
    name: "network_interrupt_reconnect",
    description: "interrupt worker connectivity and verify reconnect/retry does not lose the task",
    realSteps: ["submitTask", "networkDown", "networkUp", "waitResult", "assertNoDuplicateCompletion"],
    mock: async (ctx) => {
      const taskId = ctx.submitTask("network-interrupt");
      ctx.networkDown();
      ctx.workerTick("worker-a");
      ctx.networkUp();
      ctx.workerTick("worker-a");
      ctx.completeTask(taskId, "worker-a");
      ctx.assertCompletedOnce(taskId);
      ctx.assertEvent(taskId, "network_restored");
    }
  }
];

const selected = String(args.scenarios ?? scenarioDefinitions.map((scenario) => scenario.name).join(","))
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const scenarios = scenarioDefinitions.filter((scenario) => selected.includes(scenario.name));
if (scenarios.length !== selected.length) {
  const known = new Set(scenarioDefinitions.map((scenario) => scenario.name));
  const unknown = selected.filter((name) => !known.has(name));
  throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

const finishedAt = new Date().toISOString();
const evidence = {
  schemaVersion: "a2a-docker-runner.chaos-e2e.v1",
  ok: results.every((result) => result.ok),
  mode,
  startedAt,
  finishedAt,
  durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  workDir: redactPath(workDir),
  environment: {
    node: process.version,
    platform: process.platform,
    ci: Boolean(process.env.CI),
    gitSha: await gitSha()
  },
  requiredCoverage: [
    "broker_restart",
    "worker_kill",
    "stale_requeue",
    "duplicate_delivery_tolerance",
    "network_interrupt_reconnect"
  ],
  scenarios: results
};

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.ok ? 0 : 1);

async function runScenario(scenario) {
  const started = Date.now();
  const events = [];
  try {
    if (mode === "mock") {
      await scenario.mock(createMockContext(events));
    } else {
      await runRealScenario(scenario, events);
    }
    return {
      name: scenario.name,
      ok: true,
      durationMs: Date.now() - started,
      description: scenario.description,
      events
    };
  } catch (error) {
    return {
      name: scenario.name,
      ok: false,
      durationMs: Date.now() - started,
      description: scenario.description,
      error: actionableError(error, scenario),
      events
    };
  }
}

async function runRealScenario(scenario, events) {
  for (const step of scenario.realSteps) {
    await runHook(step, scenario.name, events);
  }
}

async function runHook(step, scenario, events) {
  const envName = `A2A_CHAOS_${camelToSnake(step)}_CMD`;
  const command = process.env[envName];
  if (!command) {
    throw new Error(`missing ${envName}; real mode requires a command hook for step '${step}'`);
  }
  const started = Date.now();
  const result = await shell(command, {
    A2A_CHAOS_SCENARIO: scenario,
    A2A_CHAOS_STEP: step,
    A2A_CHAOS_WORK_DIR: workDir
  });
  events.push({
    type: "hook",
    step,
    envName,
    ok: result.code === 0,
    durationMs: Date.now() - started,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr)
  });
  if (result.code !== 0) {
    throw new Error(`${envName} exited ${result.code}: ${trim(result.stderr || result.stdout)}`);
  }
}

function createMockContext(events) {
  const state = {
    brokerRestarts: 0,
    networkOnline: true,
    workers: new Map([["worker-a", "online"], ["worker-b", "online"]]),
    tasks: new Map()
  };

  const emit = (event) => events.push({ at: new Date().toISOString(), ...event });
  return {
    submitTask(kind) {
      const id = `${kind}-${state.tasks.size + 1}`;
      state.tasks.set(id, { status: "queued", claims: [], completions: 0, events: ["submitted"] });
      emit({ type: "task_submitted", taskId: id });
      return id;
    },
    restartBroker() {
      state.brokerRestarts += 1;
      emit({ type: "broker_restarted", count: state.brokerRestarts });
    },
    claimTask(taskId, worker = "worker-a") {
      const task = mustTask(state, taskId);
      if (state.workers.get(worker) !== "online") throw new Error(`${worker} is not online`);
      if (!state.networkOnline) {
        emit({ type: "claim_deferred_network_down", taskId, worker });
        return;
      }
      task.status = "claimed";
      task.claims.push(worker);
      task.events.push("claimed");
      emit({ type: "task_claimed", taskId, worker });
    },
    workerTick(worker = "worker-a") {
      const task = [...state.tasks.entries()].find(([, value]) => value.status === "queued")?.[0];
      if (task) this.claimTask(task, worker);
    },
    killWorker(worker) {
      state.workers.set(worker, "dead");
      emit({ type: "worker_killed", worker });
    },
    markStale(taskId) {
      const task = mustTask(state, taskId);
      task.status = "stale";
      task.events.push("stale");
      emit({ type: "task_marked_stale", taskId });
    },
    requeueStale() {
      for (const [taskId, task] of state.tasks) {
        if (task.status === "stale") {
          task.status = "queued";
          task.events.push("requeued_stale");
          emit({ type: "task_requeued_stale", taskId });
        }
      }
    },
    injectDuplicate(taskId) {
      const task = mustTask(state, taskId);
      task.events.push("duplicate_delivered");
      emit({ type: "duplicate_delivery_injected", taskId });
    },
    networkDown() {
      state.networkOnline = false;
      emit({ type: "network_interrupted" });
    },
    networkUp() {
      state.networkOnline = true;
      for (const task of state.tasks.values()) task.events.push("network_restored");
      emit({ type: "network_restored" });
    },
    completeTask(taskId, worker = "worker-a") {
      const task = mustTask(state, taskId);
      if (task.status === "completed") {
        task.events.push("duplicate_ignored");
        emit({ type: "duplicate_completion_ignored", taskId, worker });
        return;
      }
      task.status = "completed";
      task.completions += 1;
      task.events.push("completed");
      emit({ type: "task_completed", taskId, worker });
    },
    assertCompletedOnce(taskId) {
      const task = mustTask(state, taskId);
      if (task.status !== "completed" || task.completions !== 1) {
        throw new Error(`expected ${taskId} completed exactly once, got status=${task.status} completions=${task.completions}`);
      }
      emit({ type: "assertion", assertion: "completed_once", taskId, ok: true });
    },
    assertEvent(taskId, event) {
      const task = mustTask(state, taskId);
      if (!task.events.includes(event)) throw new Error(`expected ${taskId} event '${event}', saw ${task.events.join(",")}`);
      emit({ type: "assertion", assertion: "event_present", taskId, event, ok: true });
    }
  };
}

function mustTask(state, taskId) {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  return task;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--real") parsed.real = true;
    else if (arg === "--mock") parsed.real = false;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      parsed[key.replaceAll("-", "_")] = inline ?? argv[++index];
    }
  }
  return {
    ...parsed,
    timeoutMs: parsed.timeout_ms,
    workDir: parsed.work_dir
  };
}

function shell(command, extraEnv) {
  return new Promise((resolvePromise) => {
    const child = execFile("/bin/sh", ["-lc", command], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolvePromise({
        code: error?.code ?? 0,
        stdout: redact(stdout),
        stderr: redact(stderr)
      });
    });
    child.stdin?.end();
  });
}

async function gitSha() {
  const result = await shell("git rev-parse --short HEAD 2>/dev/null || true", {});
  return trim(result.stdout) || null;
}

function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toUpperCase();
}

function trim(value) {
  return String(value ?? "").trim().slice(0, 4000);
}

function redact(value) {
  return String(value ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_TOKEN]")
    .replace(/(token|secret|password)=([^\s]+)/gi, "$1=[REDACTED]");
}

function redactPath(value) {
  const cwd = process.cwd();
  return String(value).startsWith(cwd) ? String(value).replace(cwd, "$REPO") : String(value).replace(process.env.HOME ?? "", "$HOME");
}

function actionableError(error, scenario) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    diagnostics: [
      `scenario '${scenario.name}' failed while exercising: ${scenario.description}`,
      mode === "real" ? "check the failing hook command, broker/worker logs, and task evidence for the scenario/step env vars" : "mock mode failure indicates the release-gate model regressed"
    ],
    realModeRequiredHooks: scenario.realSteps.map((step) => `A2A_CHAOS_${camelToSnake(step)}_CMD`)
  };
}
