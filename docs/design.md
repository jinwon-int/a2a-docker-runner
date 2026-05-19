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

## Completion envelope (execution evidence → terminal evidence → handler result)

The runner produces a layered evidence model that wraps each task's result:

### Layer 1: `RunnerResult` (raw execution output)

Written as JSON to stdout by `a2a-docker-runner run` and consumed by the worker
handler. Contains the full execution context:

- `ok`, `taskId`, `status`, `exitCode`, `stdout`, `stderr`
- `artifacts`, `artifactManifest` — structured file inventory
- `resultSummary` — bounded, redacted summary fields safe for payloads
- `github` — structured GitHub evidence (prUrl / doneCommentUrl / blockCommentUrl)
- **`executionProof`** — cryptographic digest chain linking task input → expanded
  commands → output. Tamper-evident, independently verifiable.
- `templateExpansion` — evidence of template variable expansion when a built-in
  or inline template was used.

### Layer 2: `TerminalEvidenceEvent` (compact broker payload)

Built by `buildTerminalEvidenceEvent()` in `src/integration.ts`. This is the
compact, payload-safe event sent to the broker for SSE/webhook delivery:

- `eventId`, `dedupeKey` — stable identity for broker replay/deduplication
- `evidenceKind` — one of PR / Done / Block / BudgetLimited / TimedOut /
  MissingEvidence; derived from structured GitHub evidence fields
- `status` — succeeded / failed / blocked / cancelled
- `alert` — preformatted compact notification text; never contains raw runner
  logs, private paths, or secrets
- `testSummary` — bounded exit code, timeout, and artifact count
- `terminalBrief` — optional parent-round context for multi-worker Terminal
  Brief notifications. Only present when the broker supplied Terminal Brief
  payload fields (n/N sequence/total). Not default-on: the runner produces
  the event unconditionally, but the Terminal Brief context requires explicit
  broker input.
- `safetyState` — hard-coded flags: `noLiveProviderSend: true`,
  `terminalAck: "requires_operator_receipt"`,
  `providerSendIsReceiptEvidence: false`

### Layer 3: `HandlerResult` (worker-facing closeout)

Built by `buildHandlerResult()` in `src/integration.ts`. This is what the
worker handler returns after runner execution:

- `status` — pr_opened / done / blocked
- `prUrl`, `startCommentUrl`, `blockCommentUrl`, `doneCommentUrl` — canonical
  evidence URLs
- `summary`, `tests`, `filesChanged`, `risks` — structured closeout fields
- `terminalEvidence` — the full Layer 2 event, embedded for the handler to
  relay to the broker
- `runnerRaw` — original runner JSON (for debugging)

### Data flow

```text
Runner execution
      │
      ▼
RunnerResult (incl. execution proof + template expansion)
      │ serialized to stdout JSON
      ▼
Handler: parseRunnerOutput → RawRunnerOutput
      │
      ├─ buildHandlerResult → HandlerResult (embedding terminalEvidence)
      └─ buildTerminalEvidenceEvent → TerminalEvidenceEvent
      │
      ▼
Broker report: HandlerResult.status + terminalEvidence.alert + evidence URLs
```

### Execution proof

The `ExecutionProof` (`a2a.runner.execution-proof.v1`, `src/execution-proof.ts`)
provides tamper-evident linkage for audit and stability gates:

- `inputDigest` — SHA-256 of the normalized task before expansion
- `expandedDigest` — SHA-256 after template expansion (identical to inputDigest
  when no expansion occurred)
- `outputDigest` — SHA-256 of container stdout + stderr
- `chainDigest` — SHA-256 linking input → expanded → output

It is stored in both `RunnerResult.executionProof` and the artifact manifest
(`artifacts/manifest.json`) so consumers at any layer can verify integrity.

The `ExecutionProof` is not propagated into the `TerminalEvidenceEvent` by
default to keep the broker payload compact. The artifact manifest is the
canonical source. Handlers that need proof-level verification should read the
manifest path from `RunnerResult.resultSummary.manifestPath`.

## Non-goals for MVP

- replacing the broker
- replacing worker heartbeat/claim logic
- mounting the full host OpenClaw workspace
- long-lived task containers
- baking `openclaw-plugin-a2a` into the runner image as permanent state
