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
- clone one or more target repos inside the container
- run bounded commands with CPU/RAM/timeout limits
- return structured stdout/stderr/artifacts/PR URL
- clean containers automatically; keep task artifacts for audit/TTL cleanup

Phase 2 can add generic analyze/backfill task support.

## CLI

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js install
node dist/cli.js cleanup --ttl 24h --dry-run
node dist/cli.js run examples/task.github.json
node dist/cli.js run examples/task.openclaw-plugin-a2a.json
```

## OpenClaw plugin A2A development preset

The first-class A2A development path is to keep the runner stateless and clone `openclaw-plugin-a2a` for each job:

```json
{
  "id": "issue-76-plugin-run",
  "intent": "propose_patch",
  "preset": "openclaw-plugin-a2a-dev",
  "timeoutMs": 2700000
}
```

The preset expands to:

- checkout `https://github.com/jinon86/openclaw-plugin-a2a.git` into `/work/openclaw-plugin-a2a`
- run `cd /work/openclaw-plugin-a2a && npm ci`
- run `cd /work/openclaw-plugin-a2a && npm test`
- write command logs and task metadata under `/work/artifacts`

For integration jobs, pass explicit repos and commands instead:

```json
{
  "id": "plugin-core-integration",
  "intent": "propose_patch",
  "repos": [
    { "name": "plugin", "url": "jinon86/openclaw-plugin-a2a", "path": "plugin", "primary": true },
    { "name": "openclaw", "url": "jinon86/openclaw", "path": "openclaw" }
  ],
  "commands": [
    "cd /work/plugin && npm ci",
    "cd /work/plugin && npm test"
  ]
}
```

This keeps `a2a-docker-runner` as the disposable execution sandbox while `openclaw-plugin-a2a` remains the main development repo.

## Worker operations

`doctor` prints JSON status for worker readiness checks:

- `docker` and `podman` availability
- configured task-root access and permissions
- optional GitHub hosts secret readability and intended `:ro` container mount
- configured base-image presence or pull readiness

`install` (alias: `setup`) is safe to rerun. It creates the task root with private permissions when missing and validates the optional secret file without touching live services.

`cleanup` removes task working directories older than a TTL. Always use `--dry-run` first on real workers:

```bash
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks node dist/cli.js cleanup --ttl 2d --dry-run
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks node dist/cli.js cleanup --ttl 2d
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
