# Runner closeout review for `a2a-plane#249`

Reviewed PRs:

- `jinwon-int/a2a-docker-runner#210` — Team2 / `jingun`, runner config/schema parity audit and pre-PR bootstrap guard hardening.
- `jinwon-int/a2a-docker-runner#211` — Team1 / `nosuk`, runner pre-deploy config validation.

## Closeout decision

Both PRs are aligned with the `a2a-plane#249` goal of preventing config/schema skew from reaching a Gateway restart, but they cover different layers and should stay independently reviewable:

1. **#210 covers branch/evidence safety and the schema-parity audit.** It documents that runner configuration is currently environment-driven rather than plugin-config-driven, so new Gateway plugin config fields should not be inferred from runner environment variables. Its pre-PR guard direction is correct: fail closed when OpenClaw runtime/bootstrap context paths would enter a PR branch or artifact evidence, while keeping reported paths relative and source-public.
2. **#211 covers local runner config validation.** It adds fail-fast validation for the runner's effective runtime config before task execution. That is useful as a runner-side guardrail, but it does not replace plugin manifest validation because Gateway config keys must still be registered in the owning plugin schema.

## Merge-readiness checks

Before either PR is merged, verify the following from the PR branch:

```sh
npm run check
npm test
npm run lint
node scripts/pre-pr-bootstrap-guard.mjs --repo-dir .
```

For PR-producing runner jobs, also verify immediately before `git add`, commit, push, or PR creation that no runtime/bootstrap context files would enter either the branch or artifact evidence. Offending paths must be reported exactly and relatively, for example:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/<file>`
- `artifacts/AGENTS.md`
- `artifacts/.openclaw/<file>`

## Review notes

- Keep #210's audit text source-public: do not include raw OpenClaw workspace context, host-specific private paths, or session dumps.
- Keep #211 focused on config validation. If fixture updates such as `tmp/chaos-e2e-evidence.json` are not required by the validation change, prefer dropping that churn before merge.
- If runner settings later move from environment variables into Gateway/plugin config, add an explicit schema section in the owning plugin manifest first; do not rely on runner-side validation alone.
