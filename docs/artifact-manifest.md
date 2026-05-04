# Artifact manifest contract

The runner writes a stable, public-demo-safe manifest to `artifacts/manifest.json` for every task. Version 1 projects runner output into A2A `Artifact`/`Part` concepts: the manifest is the task `Artifact`, and each item in `evidence` is a renderable `Part` backed by an optional artifact file.

Schema: [`docs/artifact-manifest.schema.json`](artifact-manifest.schema.json)  
Sample: [`examples/artifact-manifest.dummy-task.json`](../examples/artifact-manifest.dummy-task.json)

## Required fields

- `artifactVersion`: stable public contract version. Current value: `1`.
- `schemaVersion`: backward-compatible alias for older runner consumers. Current value: `1`.
- `manifestPath`: always `artifacts/manifest.json`.
- `generatedAt`: deterministic generation timestamp; current runner uses `1970-01-01T00:00:00.000Z` so identical artifacts produce stable manifests.
- `status`: one of `done`, `blocked`, `failed`, or `budget_limited`. `budget_limited` is not Done; it means bounded execution stopped and any continuation must be separately approved.
- `summary`: non-empty operator-friendly text for broker/plugin cards.
- `evidence`: array of A2A Part-like evidence entries.
- `artifacts`: file inventory backing the manifest.

## Optional task fields

- `taskId`, `repo`, `branch`, `prUrl`, `issueUrl`.
- `budget`: bounded, redacted budget-stop metadata (`limitKind`, optional `limit`/`used`/`reason`) when `status=budget_limited`.
- `receiptTrace`: optional bounded notification/receipt correlation metadata for broker/plugin receipt-gap reports. It may carry safe identifiers such as `outboxId`, `notificationId`, `dedupeKey`, `channel`, `status`, `evidence`, `receiptId`, `attemptCount`, `staleAfterMs`, and bounded `reason`; it must not contain raw prompts, raw command output, message bodies, tokens, or private host paths.
- `continuation`: optional approval-gated follow-up recommendation; `requiresApproval` must be `true`.

## Evidence parts

Each `evidence[]` entry has:

- `kind`: `log`, `test`, `diff`, or `file`.
- `label`: short display label.
- `status`: optional `passed`, `failed`, `blocked`, or `unknown`.
- `path`: optional artifact path relative to the task work directory.
- `excerpt`: optional bounded, redacted preview. Consumers should render `summary` first, then evidence labels/excerpts; they should not need to read raw logs to avoid empty-success regressions.

## Receipt trace compatibility

`receiptTrace` is additive and backward-compatible. Older consumers can ignore it; newer broker/plugin closeout reports can use it to correlate runner artifacts with terminal-outbox receipt states when receipts are pending, stale, failed, or confirmed. The status vocabulary intentionally distinguishes provider/send progress (`accepted`, `started`, `produced`, `provider_sent`) from operator-visible or acknowledged receipt evidence (`operator_visible`, `operator_confirmed`, `provider_delivery_receipt`, `receipt_confirmed`). Provider send success alone must not be rendered as a completed receipt.

The runner only copies explicitly supplied receipt trace metadata from `task.receiptTrace` or JSON in `task.env.A2A_RUNNER_RECEIPT_TRACE` / `A2A_RECEIPT_TRACE`, and it bounds/redacts string fields before writing `manifest.json` or `resultSummary`.

GitHub evidence remains fail-closed: `github-propose-patch` tasks still fail when no PR/Done/Block URL is produced. The artifact manifest is additive evidence for rendering and public demos, not a replacement for canonical GitHub closeout evidence.
