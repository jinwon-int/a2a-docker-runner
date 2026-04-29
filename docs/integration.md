# Handler Integration

`openclaw-a2a-worker` handler (`openclaw-a2a-task-handler.mjs`) calls `a2a-docker-runner` for `github-propose-patch` / `propose_patch` tasks instead of mutating the host workspace directly.

## Architecture

```text
Broker ──claim──▶ Worker ──dispatch──▶ Handler
                                         │
                          github-propose-patch detection
                                         │
                              ┌──────────┴──────────┐
                              │  A2A_DOCKER_RUNNER   │
                              │     _ENABLED?        │
                              └──────┬──────┬────────┘
                                     │ yes  │ no
                                     ▼      ▼
                          a2a-docker-runner   Legacy openclaw agent path
                               run               (direct workspace)
                                │
                          Container sandbox
                          ┌───────────────┐
                          │ git clone      │
                          │ commands       │
                          │ artifacts/     │
                          └───────────────┘
                                │
                          RunnerResult JSON
                                │
                          HandlerResult
                                │
                          Broker report
```

## Import

The integration module exports helper functions that the handler can import:

```js
import {
  isGithubProposePatchTask,
  isEnvTruthy,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
} from "a2a-docker-runner";
```

TypeScript:
```ts
import {
  isGithubProposePatchTask,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
  type HandlerTask,
  type HandlerEnv,
  type HandlerResult,
} from "@openclaw/a2a-docker-runner";
```

## Handler Integration Flow

### Step 1: Detect

```js
if (isGithubProposePatchTask(task) && shouldUseDockerRunnerForGithub(task, env)) {
  return handleViaDockerRunner(task, env);
}
```

### Step 2: Build runner task

```js
const runnerTask = buildRunnerTaskFromHandlerPayload(task, env);

// runnerTask = {
//   id: "...",
//   intent: "propose_patch",
//   mode: "github-propose-patch",
//   repo: "jinon86/openclaw-plugin-a2a",
//   preset: "openclaw-plugin-a2a-dev",
//   issueUrl: "https://github.com/jinon86/openclaw-plugin-a2a/issues/42",
//   ...
// }
```

### Step 3: Execute

```js
// Write task.json
await fs.writeFile(taskPath, JSON.stringify(runnerTask));

// Spawn runner
const { stdout, stderr, code } = await spawn(
  env.A2A_DOCKER_RUNNER_BIN || "a2a-docker-runner",
  ["run", taskPath],
);

if (code !== 0) throw new Error(stderr);
```

### Step 4: Parse & build result

```js
const parsed = parseRunnerOutput(stdout);
const handlerResult = buildHandlerResult(parsed, task, nodeId);

// handlerResult = {
//   status: "pr_opened",
//   summary: "...",
//   prUrl: "https://github.com/.../pull/42",
//   ...
// }
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `A2A_DOCKER_RUNNER_ENABLED` | `0` | Master switch. Set `1`/`true`/`yes`/`on` |
| `A2A_DOCKER_RUNNER_ALL_GITHUB` | `0` | Route all github-propose-patch tasks through runner |
| `A2A_DOCKER_RUNNER_PRESET` | — | Default preset (e.g. `openclaw-plugin-a2a-dev`) |
| `A2A_DOCKER_RUNNER_BIN` | `a2a-docker-runner` | Runner binary path |
| `A2A_DOCKER_RUNNER_ARGS_JSON` | `[]` | Extra CLI args before `run` |
| `A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS` | `2700000` (45m) | Task timeout override |
| `A2A_DOCKER_RUNNER_ROOT` | `/var/lib/openclaw-a2a/tasks` | Runtime root dir |
| `A2A_DOCKER_RUNNER_IMAGE` | `node:22-bookworm-slim` | Container image |
| `A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE` | — | gh hosts.yml for container auth |

## Broker Claim/Heartbeat (untouched)

This integration does **not** modify:
- Broker task claim flow
- Worker heartbeat loop
- Proposal lifecycle
- Broker request/response format

The handler continues to claim → execute → report using the same broker protocol. The only change is *how* `github-propose-patch` tasks are executed inside the worker.

## Failure Modes

| Failure | Evidence |
|---|---|
| Runner binary missing | Handler throws; broker sees handler_error |
| Container fails | Runner returns `ok: false` + `error`; handler returns `status: "blocked"` |
| Timeout | Runner returns `ok: false, status: "timeout"` |
| No GitHub token | Runner can't post Block/Done comments; evidence.`blockCommentUrl` stays undefined |
| No PR generated | Runner posts Done comment; handler returns `status: "done"` |

## Active Worker Nodes

| Node | Expected integration state |
|---|---|
| bangtong | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| dungae | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| sogyo | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| nosuk | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| yukson | **Excluded** (legacy, no integration) |
