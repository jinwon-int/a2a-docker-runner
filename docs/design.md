# Design

## Components

- **Broker**: unchanged control plane.
- **Host worker**: unchanged task claim/heartbeat/reporting process.
- **Docker runner**: local execution engine called by the worker handler.
- **Task container**: disposable execution sandbox.

## Task lifecycle

1. worker claims task from broker
2. handler writes canonical `task.json`
3. runner creates `/var/lib/openclaw-a2a/tasks/<taskId>`
4. runner starts container with bounded CPU/RAM/time
5. container performs repo/task work
6. runner collects artifacts and result JSON
7. handler reports completion/failure to broker
8. cleanup timer removes old task dirs

## Non-goals for MVP

- replacing the broker
- replacing worker heartbeat/claim logic
- mounting the full host OpenClaw workspace
- long-lived task containers
