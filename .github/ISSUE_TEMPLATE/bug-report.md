---
name: Bug report
about: Report a bug in the A2A Docker Runner
title: ''
labels: bug
assignees: ''
---

## Describe the bug

A clear and concise description of the bug.

## To reproduce

Steps to reproduce the behavior:

1. Task payload or runner invocation:
   ```json
   { ... }
   ```
2. Runner command:
   ```bash
   A2A_DOCKER_RUNNER_ENGINE=docker node dist/cli.js run ...
   ```
3. Observed behavior

## Expected behavior

A clear description of what you expected to happen.

## Runner output

Attach or paste the runner JSON output (redact any tokens or secrets):

```json
{ ... }
```

## Environment

- Node.js version: `node --version`
- Docker/Podman version: `docker --version` / `podman --version`
- OS: (e.g., Ubuntu 24.04, macOS)
- Runner version: `node dist/cli.js doctor | jq .runnerRevision`

## Additional context

Add any other context about the problem here. Do not include tokens, secrets,
private host paths, or raw session data.
