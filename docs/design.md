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

## Non-goals for MVP

- replacing the broker
- replacing worker heartbeat/claim logic
- mounting the full host OpenClaw workspace
- long-lived task containers
- baking `openclaw-plugin-a2a` into the runner image as permanent state
