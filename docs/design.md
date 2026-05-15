# Design

## Components

- **Broker**: unchanged control plane.
- **Host worker**: unchanged task claim/heartbeat/reporting process.
- **Docker runner**: local execution engine called by the worker handler.
- **Task container**: disposable execution sandbox.
- **Target repos**: cloned per job; never treated as permanent runner state.

## Task lifecycle

1. worker claims task from broker
2. handler writes canonical `task.json`
3. runner creates `/var/lib/openclaw-a2a/tasks/<taskId>`
4. runner expands presets, repos, and commands
5. runner starts container with bounded CPU/RAM/time
6. container clones task repos into `/work/<repo-path>`
7. container executes configured commands
8. runner collects artifacts and result JSON
9. handler reports completion/failure to broker
10. cleanup timer removes old task dirs

## OpenClaw plugin A2A development path

`a2a-docker-runner` is the sandbox, not the durable development workspace.

For A2A feature work, the recommended job shape is:

```text
a2a-docker-runner
  └─ task container
      ├─ /work/openclaw-plugin-a2a   primary checkout
      ├─ /work/openclaw              optional integration checkout
      ├─ /work/a2a-broker            optional broker checkout
      └─ /work/artifacts             logs, result metadata, evidence
```

The built-in `openclaw-plugin-a2a-dev` preset clones `jinwon-int/openclaw-plugin-a2a` and runs its normal install/test path. More complex jobs should use explicit `repos` and `commands` so each task declares exactly what it needs.

## Deployment marker (`.deploy-source-sha`)

After deployment, the runner checkout may contain a `.deploy-source-sha` file that
records the deployed commit SHA. This file is an expected deployment artifact, not
a sign of workspace drift.

The `doctor` command and deploy validation in `checkDeployedRevision`
(`src/ops.ts`) explicitly filter `.deploy-source-sha` from the dirty-worktree
detection logic:

1. `git status --porcelain` output is parsed per-line; lines mentioning
   `.deploy-source-sha` are excluded from the dirty flag.
2. If `.deploy-source-sha` is detected in the porcelain output, a
   `deploymentMarker: true` field is included in the check detail so operators
   can see it was recognized.
3. Real untracked or modified source files (anything besides
   `.deploy-source-sha`) still trigger a normal dirty-worktree warning.

This means:

| Worktree state | dirty flag | deploymentMarker | doctor status |
|---|---|---|---|
| Clean main | `false` | `false` | `ok` |
| `.deploy-source-sha` only | `false` | `true` | `ok` |
| `.deploy-source-sha` + real dirty file | `true` | `true` | `warn` |
| Real dirty files only (no marker) | `true` | `false` | `warn` |

## Latency optimization: OpenClaw patch containers

Measured OpenClaw startup breakdown on `jingun/vps8`:

| Phase | Time | Share |
|---|---|---|
| **runtime-plugins** | 9210 ms | **96%** |
| model-resolution | 194 ms | 2% |
| auth | 190 ms | 2% |
| context-engine | 2 ms | <1% |
| hooks | 2 ms | <1% |
| workspace | 1 ms | <1% |
| attempt-dispatch | 5 ms | <1% |
| **Total** | **9604 ms** | **100%** |

The `runtime-plugins` phase dominates because OpenClaw loads every bundled
plugin at startup. In a short-lived patch container none of the bundled plugins
are needed — the container only runs `git`, `gh`, and the OpenClaw agent itself.

The runner defaults `A2A_OPENCLAW_DISABLE_BUNDLED_PLUGINS=1` to skip this
~9-second penalty. Operators can set it back to `0` if the patch agent requires
plugin features.

## Non-goals for MVP

- replacing the broker
- replacing worker heartbeat/claim logic
- mounting the full host OpenClaw workspace
- long-lived task containers
- baking `openclaw-plugin-a2a` into the runner image as permanent state
