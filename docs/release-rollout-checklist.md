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
