# Runner config/schema parity audit

Parent: `a2a-plane#249`

## Scope

This audit cross-checks runner-side configuration surfaces in this repository against the A2A broker adapter plugin manifest surface (`openclaw.plugin.json`, owned by `jinwon-int/openclaw-plugin-a2a`). This repository does not contain that manifest, so runner changes here must stay source-only and avoid pretending to patch the plugin schema from the runner repo.

Checked local runner surfaces:

- `src/integration.ts` handler environment passthrough (`A2A_DOCKER_RUNNER_ENABLED`, routing, binary, args, task timeout)
- `src/config.ts` runner runtime environment (`A2A_DOCKER_RUNNER_*`, `A2A_OPENCLAW_*`)
- `src/task-normalizer.ts` default GitHub PR pipeline and pre-PR evidence guard
- `scripts/pre-pr-bootstrap-guard.mjs` standalone bootstrap guard

## Findings

1. **Runner configuration is environment-driven, not plugin-config-driven.**
   The runner consumes `A2A_DOCKER_RUNNER_*` / `A2A_OPENCLAW_*` from process env. Those values are not currently read from `plugins.entries.a2a-broker-adapter.config`, so they should not be added ad hoc to Gateway config unless the plugin manifest registers them first.

2. **The plugin manifest needs to remain the only source of truth for Gateway config keys.**
   The parent issue's `operatorEvents.crossBrokers` incident class happens when runtime code reads a plugin config key that is absent from `openclaw.plugin.json` while `additionalProperties: false` is active. Runner env knobs avoid that class only while they remain outside plugin config.

3. **Pre-PR bootstrap context guard should block branch/evidence leaks, not ignored prompt context.**
   OpenClaw runner containers may mount ignored workspace context files such as `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`. These must fail closed if tracked, staged, unignored, or copied into artifacts, but ignored untracked prompt context should not create false PR blocks.

## Proposed schema patch if runner config moves into plugin config

If operators want to manage runner settings through Gateway/plugin config instead of environment variables, add an explicit nested object to the plugin manifest rather than placing env-style keys at the top level:

```json
{
  "dockerRunner": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": false },
      "allGithub": { "type": "boolean", "default": false },
      "preset": { "type": "string", "minLength": 1 },
      "bin": { "type": "string", "minLength": 1 },
      "argsJson": { "type": "string", "minLength": 2 },
      "taskTimeoutMs": { "type": "integer", "minimum": 1 },
      "rootDir": { "type": "string", "minLength": 1 },
      "image": { "type": "string", "minLength": 1 },
      "githubTokenFile": { "type": "string", "minLength": 1 }
    }
  }
}
```

Keep executor-bearing values (`patchCommandScript`, `patchCommandJson`, `extraMountsJson`, OpenClaw config directory, host network, memory/CPU limits) operator-only and separately reviewed before exposing them in Gateway config because they affect trusted-worker execution boundaries.

## Patch applied in this repo

- Made bootstrap guards Git-aware: ignored untracked OpenClaw context files do not block, while tracked/staged/unignored paths still fail closed before PR creation.
- Kept artifact evidence fail-closed: banned files copied into `/work/artifacts` still block with exact artifact-relative paths.
- Added regression coverage for ignored-vs-staged bootstrap files.
