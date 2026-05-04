# A2A Docker Runner

Docker/Podman task runner for OpenClaw A2A workers.


## Repository role in the A2A layout

`a2a-docker-runner` is the isolated execution engine for A2A worker tasks.

It owns:

- one-container-per-task Docker/Podman execution
- GitHub repository checkout, patch command execution, commit/push/PR creation, and artifact collection
- generic coding-agent command injection through safe `commandScript` / `commandJson` paths
- artifact manifests plus PR/Block/Done evidence used by the broker contract
- read-only secret/config mounts for coding-agent credentials and GitHub auth

It does **not** own task routing, worker lifecycle, stale recovery, or OpenClaw gateway methods. Those live in [`jinwon-int/a2a-broker`](https://github.com/jinwon-int/a2a-broker) and [`jinwon-int/openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a).

Current production baseline as of 2026-04-30:

- deployed on `bangtong`, `sogyo`, `dungae`, `nosuk`
- all generic GitHub patch tasks route Docker-first via the broker worker handler
- the coding-agent command is configured externally by worker environment, not embedded in this repo
## Why

A2A workers currently execute delegated work in the host OpenClaw workspace. After many tasks, repos, build artifacts, logs, and session files can mix together and make local OpenClaw unhealthy. This runner keeps task execution isolated:

```text
A2A Broker → Host A2A Worker → A2A Docker Runner → one task container
```

The broker stays unchanged. The host worker still claims tasks and reports results over the existing HTTP broker endpoint and edge-secret contract. The broker may be hosted by Docker Compose, systemd, or another supervisor; this runner does not require or manage the broker process. The runner is only the execution engine used by the worker for file-heavy jobs.

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
node dist/cli.js run examples/task.canonical.json
node dist/cli.js run examples/task.github.json
node dist/cli.js run examples/task.github-evidence.json
node dist/cli.js run examples/task.github-propose-patch.json
node dist/cli.js run examples/task.openclaw-plugin-a2a.json
```

## Canonical A2A Task Format

The full `github-propose-patch` mode task accepts:

```json
{
  "id": "canonical-github-propose-patch",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "commands": ["..."],
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/1",
  "reportLanguage": "ko",
  "requestedBy": "dungae",
  "timeoutMs": 300000
}
```

See `examples/task.canonical.json` for a complete example.

## PR-producing executor path (github-propose-patch)

When `mode` is `github-propose-patch` (or `propose_patch`) and no explicit
`commands` are provided, the runner generates a default PR-producing pipeline
that writes the `prompt` to `/work/artifacts/prompt.md` and executes a
configurable coding agent via the `A2A_PATCH_COMMAND` escape hatch.

Example task (see `examples/task.github-propose-patch.json`):

```json
{
  "id": "patch-readme-example",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "prompt": "Add a section to README.md.",
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/10",
  "reportLanguage": "ko",
  "requestedBy": "dungae",
  "timeoutMs": 600000
}
```

The runner will clone the repo, create a branch, run the coding agent,
commit changes, push, and open a PR. Result evidence includes
`github.prUrl`, `github.blockCommentUrl`, or `github.doneCommentUrl`
depending on the outcome.

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

- checkout `https://github.com/jinwon-int/openclaw-plugin-a2a.git` into `/work/openclaw-plugin-a2a`
- run `cd /work/openclaw-plugin-a2a && npm ci`
- run `cd /work/openclaw-plugin-a2a && npm test`
- write command logs and task metadata under `/work/artifacts`

For integration jobs, pass explicit repos and commands instead:

```json
{
  "id": "plugin-core-integration",
  "intent": "propose_patch",
  "repos": [
    { "name": "plugin", "url": "jinwon-int/openclaw-plugin-a2a", "path": "plugin", "primary": true },
    { "name": "openclaw", "url": "jinwon-int/openclaw", "path": "openclaw" }
  ],
  "commands": [
    "cd /work/plugin && npm ci",
    "cd /work/plugin && npm test"
  ]
}
```

This keeps `a2a-docker-runner` as the disposable execution sandbox while `openclaw-plugin-a2a` remains the main development repo.

## Operator terminal evidence contract

The worker-facing integration returns a compact `terminalEvidence` object for broker
push/SSE/webhook delivery. Broker/workers must treat this as notification data
only; operator Telegram and main-session delivery stay owned by
seoseo/OpenClaw `plugin-notifier`, not by this runner.

The event is intentionally small and secret-free:

- `eventId` / `dedupeKey`: stable idempotency keys for broker replay and plugin retry dedupe
- `status`: `succeeded`, `failed`, `cancelled`, or `blocked`
- `repo` and `issue`: repository plus canonical issue URL/reference
- `prUrl`, `doneUrl`, or `blockUrl`: the chosen completion evidence URL
- `alert.title`, `alert.body`, `alert.url`: compact preformatted notification text for adapters such as OpenClaw plugin-notifier
- `testSummary.label`: one-line runner outcome with exit, timeout, artifact count
- `runnerBuild`: optional bounded build metadata (`version`, `source`, `revision`, `builtAt`, `image`)
- `reason`: short human-facing Done/Block/failure reason
- Budget-limited runs are never reported as Done. If `artifactManifest.status` or
  `resultSummary.status` is `budget_limited`, broker/plugin summaries must show a
  blocked/needs-continuation outcome and include a safe next action instead of
  auto-continuing.

It must not include raw stdout/stderr, host work directories, secrets, or oversized
command output. Detailed logs remain in runner artifacts and bounded
`runnerRaw` debugging fields. Adapters should use `dedupeKey` as the durable
notification id and may render `alert` directly without re-parsing logs.

### Artifact budget/continuation contract

Modern artifacts may include sanitized budget and continuation evidence in
`artifacts/manifest.json` and the bounded `resultSummary` copy:

```json
{
  "status": "done|blocked|failed|budget_limited",
  "budget": {
    "limitKind": "time|token|attempt|command|safety",
    "limit": "45m task timeout budget",
    "used": "45m",
    "reason": "Stopped before completing validation within the bounded task budget."
  },
  "continuation": {
    "recommended": true,
    "nextPrompt": "Continue from artifacts/summary.txt; finish validation after approval.",
    "requiresApproval": true
  }
}
```

Rules:

- `budget_limited` means constrained/unfinished, not success. It must not be
  mapped to Done even if older output also contains a `doneCommentUrl`.
- `continuation.requiresApproval` must be `true`; the runner and broker must not
  start unbounded or automatic continuation loops.
- `nextPrompt` is a recommendation only. Keep it bounded, artifact-referenced,
  and secret-free; never include tokens, private env values, raw host paths, or
  oversized logs.
- A safe next action is: review the artifacts and budget reason, then approve one
  bounded follow-up task if continuation is still appropriate.

A synthetic CI fixture for this shape lives at
[`examples/runner-budget-limited-fixture.json`](examples/runner-budget-limited-fixture.json).

A CI-safe Telegram receipt smoke is available for the terminal notification ACK
contract:

```bash
npm run smoke:telegram-terminal-ack
```

The smoke uses synthetic runner output and synthetic Telegram receipt metadata.
It first proves provider send success alone leaves the terminal cursor incomplete,
then confirms ACK only after an operator-visible Telegram receipt is present. It
performs no live Telegram, broker, or GitHub writes.

For all-worker rollout evidence, merge the per-worker receipt-smoke reports into
a sanitized JSON file and run the fail-closed guard against the merge commit:

```bash
npm run rollout:receipt-evidence -- \
  --input artifacts/rollout-receipt-evidence.json \
  --expected-commit 123df9b19e2c600e826273f5b16117039aa44b6f
```

The merged evidence must contain exactly the active workers being rolled out
(`bangtong`, `dungae`, `sogyo`, `nosuk`). For each worker the guard requires the
runner artifact version and revision, a passing focused test result, an
operator-visible terminal receipt smoke result, proof that provider-send-only ACK
would not advance the cursor, and proof that there is no stale terminal-receipt
backlog. Missing workers, mismatched commits, stale backlog, or provider-send-only
ACK evidence exit non-zero. Keep the input synthetic/sanitized: no tokens, private
host paths, raw logs, or live Telegram ACKs.

## Worker operations

`doctor` prints JSON status for worker readiness checks:

- `docker` and `podman` availability
- configured task-root access and permissions
- optional GitHub hosts secret readability and intended `:ro` container mount
- configured base-image presence or pull readiness
- `githubPatch` readiness for generic `github-propose-patch` execution
- `runnerRevision` deployed-revision drift status for the runner checkout/package

`runnerRevision.detail.summary` is a compact operator line suitable for broker/plugin surfaces. It reports the deployed package version, local runner SHA, upstream GitHub `main` SHA when available, branch, and dirty-worktree state without echoing remotes, tokens, secret files, or host-specific paths. A clean current checkout returns `status: "ok"`; stale, dirty, non-main, or upstream-unavailable source checkouts return `status: "warn"` so rollout operators can review drift without blocking unrelated readiness checks.

Examples:

```text
PASS runner=v0.1.0 local=ff4c244a38a7 upstreamMain=ff4c244a38a7 branch=main dirty=no
WARN runner=v0.1.0 local=160bd95af6b4 upstreamMain=ff4c244a38a7 branch=main dirty=no
WARN runner=v0.1.0 local=ff4c244a38a7 upstreamMain=ff4c244a38a7 branch=feature/drift dirty=yes
```

To check the four deployed workers from an operator shell, run the doctor in each runner checkout and print only the compact line:

```bash
for host in bangtong dungae sogyo nosuk; do
  printf '%s ' "$host"
  ssh "$host" 'cd /opt/a2a-docker-runner && node dist/cli.js doctor | jq -r .runnerRevision.detail.summary'
done
```

`githubPatch.status` is `ok` when `commandScript` or valid `commandJson` is configured and `fail` when no patch command is configured or a legacy `commandTemplate` eval path is present. A failed `githubPatch` check means Docker-first generic GitHub patch tasks are not ready and should produce Block evidence instead of Done/no-op success.

`install` (alias: `setup`) is safe to rerun. It creates the task root with private permissions when missing and validates the optional secret file without touching live services.

`smoke` runs a tiny operator-facing container fixture through the configured Docker/Podman boundary. It exercises stdout, stderr, artifact capture, `gh` bootstrap/version evidence, timeout wiring, and engine-side cleanup (`--rm`) without touching live worker services. The default smoke bound is capped at 120s so stock `node:22-bookworm-slim` images have enough room for GitHub CLI apt bootstrap without inheriting the full task timeout:

```bash
A2A_DOCKER_RUNNER_ENGINE=docker A2A_DOCKER_RUNNER_IMAGE=node:22-bookworm-slim node dist/cli.js smoke
A2A_DOCKER_RUNNER_ENGINE=podman A2A_DOCKER_RUNNER_IMAGE=node:22-bookworm-slim node dist/cli.js smoke
```

The command returns JSON. Missing engine, missing image, and permission/daemon failures are reported in `result.error` with actionable remediation text. Secret-like values in stdout/stderr diagnostics are redacted before they are returned.

`cleanup` removes task working directories older than a TTL. Always use `--dry-run` first on real workers:

```bash
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks node dist/cli.js cleanup --ttl 2d --dry-run
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks node dist/cli.js cleanup --ttl 2d
```

## Chaos E2E release gate

Run the CI-safe gate before release prep:

```bash
npm run chaos:e2e
```

It prints and writes machine-readable JSON evidence for broker restart, worker kill, stale requeue, duplicate-delivery tolerance, and network interruption/reconnect scenarios. For staging/live-like validation, run `scripts/chaos-e2e-gate.mjs --real` with the command hooks documented in `docs/release-rollout-checklist.md`.

## Environment

See `.env.example`.

Important defaults:

- task root: `/var/lib/openclaw-a2a/tasks`
- image: `node:22-bookworm-slim`
- engine: auto-detect `docker` then `podman`

GitHub patch containers need a `gh` version with `gh pr update-branch` support.
The runner checks that capability at container startup. If `gh` is missing or too
old, it installs/updates GitHub CLI from the official `cli.github.com` apt
repository instead of relying on the older Debian package. For faster cold starts,
operators may still set `A2A_DOCKER_RUNNER_IMAGE` to a prebuilt image that already
contains current `git`, `gh`, `curl`, `gnupg`, and `ca-certificates`.

Build metadata injection:

- `A2A_DOCKER_RUNNER_BUILD_VERSION`
- `A2A_DOCKER_RUNNER_BUILD_SOURCE`
- `A2A_DOCKER_RUNNER_BUILD_REVISION`
- `A2A_DOCKER_RUNNER_BUILD_BUILT_AT`
- `A2A_DOCKER_RUNNER_BUILD_IMAGE` (falls back to `A2A_DOCKER_RUNNER_IMAGE`)

These values are injected into task containers as `A2A_RUNNER_BUILD_*`, recorded in
`run.json` / `artifacts/summary.txt`, and propagated through `resultSummary.runnerBuild`,
GitHub Done/Block comments, and terminal evidence. Keep them public and compact: the
loader bounds values, collapses newlines, and drops obvious tokens or host-specific
absolute paths instead of forwarding them.

### Patch command config

For `github-propose-patch` / `propose_patch` mode tasks **without** explicit
`commands`, the runner generates a default PR-producing pipeline. The pipeline:

1. Writes `prompt` to `/work/artifacts/prompt.md`.
2. Creates a branch, invokes the coding agent, commits changes, pushes, and
   opens a PR via `gh pr create`.

Step 2 can be configured from host environment. Prefer the safe host-side
OpenClaw/Codex paths for new rollouts. The legacy template eval path is blocked
for GitHub patch execution, and Claude-in-Docker references are rejected even if
an old opt-in variable is present. This keeps plugin preset patch tasks from
falling back to a blocked Claude-in-Docker command and falsely succeeding.

Precedence is `commandScript > commandJson > commandProfile > commandTemplate`:

| Host env | Runner config | Container path/variable | Notes |
|---|---|---|---|
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` | `commandScript` | `/work/patch-command.sh` | Recommended. Script content is written to a file and executed without `eval`. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` | `commandJson` | `/work/patch-command.sh` | JSON `{ "argv": [...], "env": {...} }` is converted into a quoted argv script. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw` | generated `commandScript` | `/work/patch-command.sh` | First-class OpenClaw profile. Mounts `A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR` or `/root/.openclaw` read-only at `/run/secrets/openclaw-dir`, then runs `openclaw agent` in the checked-out repo. Defaults to `A2A_OPENCLAW_MODEL=openai-codex/gpt-5.5` so OAuth-backed Codex auth is used instead of same-name OpenAI API-key models. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE` | `commandTemplate` | blocked | Legacy eval path; rejected for GitHub patch execution. |

Examples:

```bash
export A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT='#!/usr/bin/env bash
codex exec --full-auto "$(cat /work/artifacts/prompt.md)"'

export A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON='{"argv":["codex","exec","--full-auto","example prompt"],"env":{"SAFE":"value"}}'

# Preferred fleet default when standardising A2A Docker patch execution on OpenClaw.
export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw
export A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/root/.openclaw
export A2A_OPENCLAW_MODEL=openai-codex/gpt-5.5
export A2A_OPENCLAW_THINKING=medium
export A2A_OPENCLAW_TIMEOUT_SEC=1800

# Legacy Claude-in-Docker commands are intentionally rejected for GitHub patch tasks.
# Use host-side OpenClaw/Codex commandScript or commandJson instead.
```

When no patch command config is set, `doctor` reports `githubPatch.status: "fail"`. The generated patch pipeline now emits `error=no_patch_command_configured` and exits non-zero before any no-op PR flow can be reported as success. GitHub evidence collection treats the diagnostic as Block evidence rather than Done evidence.

After creating a PR, the default pipeline calls
`a2a-gh-pr-update-branch "$PR_URL" "$baseBranch"`. That helper first uses
`gh pr update-branch`; if GitHub CLI/API update fails, it falls back to
`git fetch origin <base>`, `git merge --no-edit origin/<base>`, and
`git push origin <head>`. Output is captured in
`/work/artifacts/pr-update-branch-output.txt`, and failures are recorded as a
warning instead of deleting or duplicating the newly created PR.

If a patch command or extra mount references Claude CLI, Claude credentials, or
Claude-specific artifacts, config loading fails. This prevents accidental
production fallback to Claude-in-Docker.

A safe Docker-first worker rollout from plugin-only routing to all-GitHub routing should therefore be:

```bash
# 1. Configure one of the safe command paths on the worker host.
export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw
export A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/root/.openclaw
export A2A_OPENCLAW_MODEL=openai-codex/gpt-5.5
export A2A_OPENCLAW_THINKING=medium
export A2A_OPENCLAW_TIMEOUT_SEC=1800

# 2. Verify readiness before enabling all GitHub tasks.
node dist/cli.js doctor | jq .githubPatch

# 3. Only after githubPatch.status is "ok", route all GitHub patch tasks via Docker.
export A2A_DOCKER_RUNNER_ALL_GITHUB=1
```

**Variables/files available inside the container:**

| Variable/File | Source |
|---|---|
| `/work/patch-command.sh` | `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` or generated from `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` |
| `A2A_PATCH_COMMAND_JSON` | `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` host env |
| `A2A_PATCH_COMMAND` | `A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE` host env |
| `/usr/local/bin/a2a-gh-pr-update-branch` | Helper that wraps `gh pr update-branch` with a git merge/push fallback |
| `/work/artifacts/prompt.md` | Task `prompt` field |
| `/work/artifacts/task.json` | Full normalised task payload |
| `/work/artifacts/manifest.json` | Versioned A2A Artifact/Part manifest; see [`docs/artifact-manifest.md`](docs/artifact-manifest.md) |

**Explicit commands override**: when `commands` are provided in the task
payload they are used as-is; the default pipeline is not injected.

## Release checklist

Operator release and worker rollout notes live in [`docs/release-rollout-checklist.md`](docs/release-rollout-checklist.md). Keep feature tasks PR-only: do not tag, publish, restart services, or deploy workers from issue branches.

The checklist covers:

- GitHub Actions Node runtime deprecation guardrails
- package `bin` verification for `a2a-docker-runner`
- active rollout targets: `bangtong`, `dungae`, `sogyo`, `nosuk`
- explicit exclusion of legacy `yukson` / VPS2 workers
- one-target-at-a-time rollout and rollback steps

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
