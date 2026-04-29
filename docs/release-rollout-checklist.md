# Runner release rollout checklist

Scope: operator checklist for proposing and rolling out an `a2a-docker-runner` release. This document is PR/release-prep only; do not tag, publish to npm, restart workers, or deploy live services from feature tasks.

## Pre-PR verification

- Confirm the branch is based on current `main` and does not include secrets, raw session dumps, or private host paths.
- Run the local gates:
  - `npm run check`
  - `npm run build`
  - `npm run lint`
  - `npm test` (includes CI-safe canary fixture — no Docker needed)
- Run the CI-safe canary explicitly when changing handler integration code:
  - `node --test dist/canary.test.js`
  - Covers PR/Done/Block/malformed/failure/crash paths end-to-end with fake runner binary.
- Verify package entry points before publishing or packaging:
  - `package.json` `bin.a2a-docker-runner` points to `./dist/cli.js`.
  - `npm test` includes the package bin contract test.
  - Optional smoke after build: `node dist/cli.js --help`.
- Keep GitHub Actions on non-deprecated action runtimes. Current CI uses `actions/checkout@v5` and `actions/setup-node@v5` with Node 22 so Node 20 runtime deprecation warnings do not become release noise.

## Active rollout targets

Active workers for this runner family:

- `bangtong`
- `dungae`
- `sogyo`
- `nosuk`

Excluded legacy target:

- `yukson` / VPS2 legacy worker is explicitly out of scope. Do not change, restart, or validate legacy Yukson/VPS2 worker services as part of this rollout.

## Rollout sequence after merge

1. Seoseo/operator reviews the merged PR and CI result.
2. Build/package from the merge commit only; do not publish from an issue branch.
3. **Pre-deploy canary**: Run CI-safe canary fixture on the merge commit: `node --test dist/canary.test.js`.
4. Roll out one active target at a time, starting with a non-critical worker when possible.
5. On each target, run `a2a-docker-runner doctor` and a small non-secret smoke task before sending real GitHub jobs.
6. Confirm the worker completion payload preserves runner evidence fields when present: `github.prUrl`, `github.doneCommentUrl`, and `github.blockCommentUrl`.
7. Continue to the next active target only after the previous target reports healthy status and expected evidence output.

## Rollback plan

- Stop rollout immediately if CI, `doctor`, package bin smoke, or evidence reporting fails on any active target.
- Revert the worker package/config on the affected target to the last known-good release or commit.
- Re-run `a2a-docker-runner doctor` and one smoke task on the reverted target.
- Record the failed target, commit, command, and sanitized logs in the follow-up issue/PR. Do not include tokens, private key material, raw session dumps, or secret file contents.
- Keep `yukson` excluded during rollback unless a separate operator-approved legacy task explicitly covers it.

## CI-safe broker canary payload (Round 4+)

The repo ships a synthetic broker canary payload at `examples/broker-canary-round4.json`.
Operators use it to validate the handler-to-runner conversion and evidence contract
without touching a live broker, Docker, or GitHub.

### Payload validation

```bash
# Validate conversion of the broker canary payload through buildRunnerTaskFromHandlerPayload:
node --test dist/canary-payload.test.js

# Full end-to-end canary (includes fake runner spawn):
node --test dist/canary.test.js
```

Both tests run in CI (no Docker required).

### Active targets in the canary payload

The fixture includes explicit active target and exclusion lists:

- **Active**: `bangtong`, `dungae`, `sogyo`, `nosuk`
- **Excluded**: `yukson` (legacy VPS2 — do not touch)

The `operatorChecklist` inside the payload describes the per-node rollout sequence.

## Evidence interpretation guide (PR / Done / Block)

After a worker executes a `github-propose-patch` task, the handler inspects the runner
output for structured `GitHubEvidence`. Operators should understand each evidence type.

### Evidence contract (from types.ts)

```typescript
interface GitHubEvidence {
  prUrl?: string;           // PR was created → status = pr_opened
  blockCommentUrl?: string;  // Task is blocked → status = blocked
  doneCommentUrl?: string;   // Task is done (no PR needed) → status = done
}
```

### Evidence resolution (from integration.ts)

In `buildHandlerResult`, evidence is resolved with this logic:

| Runner output | Handler status | Meaning |
|---|---|---|
| `github.prUrl` is set | `pr_opened` | Coding agent created a branch, committed changes, pushed, and opened a PR |
| `github.blockCommentUrl` is set (no PR) | `blocked` | Task is impossible or unsafe; operator should read the block comment |
| `github.doneCommentUrl` is set (no PR, no block) | `done` | Task completed without needing a PR (e.g., verification-only or no-change tasks) |
| No structured evidence at all | `blocked` | Degraded state — runner finished but coding agent produced no GitHub evidence. Risks array contains explanation. |

### How the broker canary payload maps to evidence

The fixture's `evidenceGuide` section documents each evidence path:

- **prUrl**: Runner emitted a PR URL → worker can create/push branches and open PRs through the coding-agent contract.
- **doneCommentUrl**: Runner posted a Done comment on the issue → used for tasks that complete without a PR.
- **blockCommentUrl**: Runner posted a Block comment → task is impossible or unsafe; inspect the block reason before proceeding.
- **noEvidence**: Runner completed without structured evidence → degraded state; investigate coding-agent output.

### Per-target evidence verification

After deploying to each active target, run a smoke task and check the handler result:

1. The handler result must carry `status: "pr_opened"`, `"done"`, or `"blocked"`.
2. The corresponding URL field (`prUrl`, `doneCommentUrl`, `blockCommentUrl`) must be present and point to a valid GitHub URL.
3. The `runnerRaw` field is preserved for debugging — do not strip it in production handlers.
4. If `status: "blocked"` and no evidence URL is present, check the `risks` array and the coding-agent log artifacts (`patch-command.log`, `pr-output.txt`).

### No evidence scenario (degraded)

When the runner completes but produces no evidence:

- Handler returns `status: "blocked"`.
- `summary` says "Docker runner completed without PR/Done/Block evidence".
- `risks` includes "runner completed without structured GitHub evidence".
- Operator should inspect: container logs, artifact files (especially `patch-command.log`),
  and the coding-agent contract (`commandScript` / `commandJson` / `commandTemplate`).
