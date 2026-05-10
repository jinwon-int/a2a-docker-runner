# Contributing

## Scope

This repository is the sandboxed execution engine for A2A worker tasks. It is
not intended for public community contribution at this stage, but structured
contributions from A2A team members are welcome.

Before starting work, check the related repositories for context:

- [`jinwon-int/a2a-broker`](https://github.com/jinwon-int/a2a-broker) — task routing and worker lifecycle
- [`jinwon-int/openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) — A2A protocol plugin
- [`jinwon-int/openclaw`](https://github.com/jinwon-int/openclaw) — OpenClaw Gateway

## Development

### Prerequisites

- Node.js >= 22
- Docker or Podman (for containerized tests and smoke)
- TypeScript 5.8+

### Quickstart

```bash
git clone https://github.com/jinwon-int/a2a-docker-runner.git
cd a2a-docker-runner
npm ci
npm run check
npm run build
npm test
```

### Local gates

```bash
npm run check          # TypeScript type-check (no emit)
npm run build          # Compile TypeScript → dist/
npm run lint           # Syntax-check JS output and scripts
npm test               # Run all test suites (builds first via pretest)
npm run chaos:e2e      # Run chaos E2E release gate (mock, CI-safe)
npm run smoke:public-demo-safety  # Audit fixtures for secret leakage
```

### Canary tests (no Docker required)

```bash
npm run build
node --test dist/canary.test.js        # Full CI-safe canary pipeline
node --test dist/canary-payload.test.js # Broker canary payload conversion
```

### Smoke test (needs Docker/Podman)

```bash
A2A_DOCKER_RUNNER_ENGINE=docker node dist/cli.js smoke
```

## Branching

- Branch from `main`
- Use descriptive branch names: `fix/redact-xai-keys`, `feat/container-network-config`
- Keep commits focused; one logical change per commit

## Tests

- New features and bug fixes must include tests
- CI-safe tests (no Docker required) run on every push/PR
- Containerized smoke tests may require Docker or Podman
- The pre-PR bootstrap guard (`scripts/pre-pr-bootstrap-guard.mjs`) fails closed
  if OpenClaw workspace files (`.openclaw/`, `SOUL.md`, `USER.md`, `IDENTITY.md`,
  `HEARTBEAT.md`, `TOOLS.md`, `MEMORY.md`, `BOOTSTRAP.md`, `memory/`) appear in
  the branch

## Pull Requests

1. Create a branch from `main`
2. Make your changes
3. Run the local gates: `npm run check && npm run build && npm run lint && npm test`
4. Run `npm run chaos:e2e` before marking ready for review
5. Open a PR with a clear description of the change
6. Do not include secrets, tokens, private host paths, raw session dumps, or
   OpenClaw workspace bootstrap files

## Code Style

- TypeScript with strict mode
- Use `node:test` and `node:assert/strict` for tests
- No external test frameworks
- Generated scripts (shell) must not use `eval`; prefer quoted argv with `exec`
