# A2A Docker Runner

Docker/Podman task runner for OpenClaw A2A workers.

## Why

A2A workers currently execute delegated work in the host OpenClaw workspace. After many tasks, repos, build artifacts, logs, and session files can mix together and make local OpenClaw unhealthy. This runner keeps task execution isolated:

```text
A2A Broker → Host A2A Worker → A2A Docker Runner → one task container
```

The broker stays unchanged. The host worker still claims tasks and reports results. The runner is the execution engine used by the worker for file-heavy jobs.

## MVP Scope

Phase 1 focuses on GitHub/PR-producing tasks:

- create one clean work directory per task
- start one container per task
- clone target repo inside the container
- run bounded commands with CPU/RAM/timeout limits
- return structured stdout/stderr/artifacts/PR URL
- clean containers automatically; keep task artifacts for audit/TTL cleanup

Phase 2 can add generic analyze/backfill task support.

## CLI

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js run examples/task.github.json
```

## Environment

See `.env.example`.

Important defaults:

- task root: `/var/lib/openclaw-a2a/tasks`
- image: `node:22-bookworm-slim`
- engine: auto-detect `docker` then `podman`

## Security model

Do not mount the full host `/root/.openclaw` into task containers. Mount only the minimum required secrets, preferably read-only, and prefer per-task or least-privilege GitHub credentials.

## Integration target

Initial integration point:

```text
/opt/openclaw-a2a-worker/handlers/openclaw-a2a-task-handler.mjs
```

For `propose_patch` / `github-propose-patch` mode, the handler should call:

```bash
a2a-docker-runner run /path/to/task.json
```

and convert the runner result into the normal A2A worker completion payload.
