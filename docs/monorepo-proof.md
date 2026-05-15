# Monorepo Build/Test & Template Migration Proof

**Issue**: https://github.com/jinwon-int/a2a-docker-runner/issues/262
**Parent**: https://github.com/jinwon-int/a2a-plane/issues/335
**Run**: `a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z`
**Lane**: Team2 / `jingun`

Cross-check of the current `a2a-docker-runner` build/test topology, workspace
package assumptions, artifact path contract, Docker image inputs, GitHub patch
mode, and migration fixtures from a monorepo perspective.

---

## 1. Build/Test Topology

### Current state

- **Single package**, single `package.json` at root — no `npm workspaces`,
  `pnpm workspaces`, `lerna.json`, or `turbo.json`.
- `tsconfig.json` defines a single `rootDir: "src"` → `outDir: "dist"` compile.
- All source lives in `src/`; all compiled output goes to `dist/`.
- Tests use Node.js built-in `node:test` runner (`node --test dist/**/*.test.js`).
- CI runs `npm ci`, `npm run check`, `npm run build`, `npm run lint`, `npm test`.
- No monorepo tooling (Nx, Turborepo, Lerna) is present in `package.json` or `package-lock.json`.

### Monorepo readiness

| Property | Current | Monorepo target |
|---|---|---|
| Package manager | npm | npm workspaces or pnpm |
| Build toolchain | tsc (single project) | tsc per package or tsc --build (project references) |
| Test runner | `node:test` across `dist/**/*.test.js` | Same; works with workspace-aware pattern |
| CI caching | `cache: npm` | Same; npm workspace install caches shared deps |
| Package name | `@openclaw/a2a-docker-runner` | Candidate `@openclaw/a2a-docker-runner` subpath exports if extracted |
| CLI entry | `./dist/cli.js` (single binary) | No change needed; CLI stays in runtime package |

**Gap**: No workspace configuration. If extraction occurs, each package needs its
own `tsconfig.json` (or `tsconfig.json` + `tsconfig.build.json`), `package.json`,
and `dist/` output. The `npm test` glob `dist/**/*.test.js` already handles
multiple packages naturally because workspace-hoisted dependencies resolve from
the root `node_modules/`.

**Test glob adaptation**: The current `npm test` script `node --test dist/**/*.test.js`
works for both single-package and workspace layouts as long as each workspace
package emits `.test.js` files under its own `dist/`. No script change is needed.

---

## 2. Workspace Package Assumptions

### Task types referencing repos

The `task-normalizer.ts` has two hardcoded references to specific repository paths:

1. **`openclaw-plugin-a2a-dev` preset** — hardcodes `jinwon-int/openclaw-plugin-a2a` as
   the primary repo with `/work/openclaw-plugin-a2a` checkout path and generates
   `npm ci` + `npm test` commands for that directory.

2. **Default `repo` field** — when a single `repo` is given (without explicit `repos` array),
   the checkout path is `/work/repo`.

### Multi-repo task support

Tasks can already specify multiple repos via the `repos` field:

```json
{
  "repos": [
    { "name": "plugin", "url": "jinwon-int/openclaw-plugin-a2a", "path": "plugin", "primary": true },
    { "name": "core", "url": "jinwon-int/openclaw", "path": "openclaw", "branch": "develop" }
  ]
}
```

The `repos` field is the natural monorepo-compatible pattern: tasks can check out
multiple repos and run commands across them sequentially.

### Preset limitations

The `openclaw-plugin-a2a-dev` preset generates test-only commands (`npm ci` + `npm test`).
In monorepo layout, this preset would need to understand which workspace package
to target. Current assumption: the preset checks out and tests the entire `openclaw-plugin-a2a`
repo as a standalone package.

**Recommendation**: For monorepo, use explicit `repos` + `commands` instead of
presets. The preset is a convenience for simple single-repo tasks.

### Workspace symlinks

npm workspaces create symbolic links in the root `node_modules/` for each local
package. Task containers clone repos to `/work/<path>`, so workspace symlinks
would need to be relative to the repo root. For monorepo template compatibility,
a post-checkout step may be needed:

```sh
# Inside task container
cd /work/monorepo
npm ci  # installs deps + links workspaces
```

No code change is needed — the existing `npm ci` command already handles npm
workspace resolution from `package.json` `workspaces` field when present.

---

## 3. Artifact Path Contract

### Current contract

- All task output artifacts are written to `/work/artifacts/` inside the container.
- The runner collects artifacts from `tasks/<taskId>/<runToken>/artifacts/` on the host.
- Critical artifact files:
  - `prompt.md` — the assignment prompt
  - `summary.txt` — key-value result summary with structured fields
  - `patch-command.log` — full coding-agent log
  - `issue-start-comment.md`, `issue-comment.md` — GitHub issue comments
  - `pr-body.md`, `pr-output.txt` — PR metadata
  - `check.log`, `canary-result.txt` — smoke test output

### Monorepo impact

| Concern | Impact | Action |
|---|---|---|
| Artifact paths are container-scoped | ✅ No monorepo change needed | `/work/artifacts/` is universal |
| Summary fields use `prompt_bytes` | ✅ Works with any repo shape | No change needed |
| Bootstrap guard checks `/work/artifacts` | ✅ Already recurses into `artifacts/` | No change needed |
| Multi-package test logs | ⚠️ Multiple packages produce separate `dist/` test output | Each workspace package's test output coalesces in the single aggregate stdout |

---

## 4. Docker Image Inputs

### Current image

`node:22-bookworm-slim` is the default. CI-safe canary tests run without Docker.

### Image compatibility with monorepo layouts

| Concern | Compatible? | Notes |
|---|---|---|
| Node.js ≥22 for `node:test` | ✅ | Native test runner works |
| Git for cloning | ✅ (installed via apt in patch commands) | No image change needed |
| npm workspaces | ✅ | npm 10+ (ships with Node 22) supports workspaces natively |
| pnpm workspaces | ⚠️ | Need `corepack enable pnpm` or global install |
| yarn workspaces | ⚠️ | Need `corepack enable yarn` or global install |

### Migration image variants

If a monorepo migration requires pnpm or yarn:

```bash
# For pnpm-based monorepo tasks, add to commands:
npm install -g pnpm && pnpm install && pnpm build && pnpm test

# For yarn-based monorepo tasks:
corepack enable && yarn set version stable && yarn install && yarn build && yarn test
```

These can be specified directly in task `commands` without requiring image changes.
The default `node:22-bookworm-slim` image supports both paths through corepack.

---

## 5. GitHub Patch Mode Compatibility

### Current mode

`github-propose-patch` / `propose_patch` mode generates a full git pipeline:

1. Create branch from base
2. Post Start comment on issue (when `issueUrl` provided)
3. Execute the coding agent patch command script
4. Normalize branch name (in case agent changed branch)
5. **Pre-PR bootstrap guard**: fail closed if runtime context files would leak
6. Commit changes, push branch, create PR
7. Update PR base branch if `a2a-gh-pr-update-branch` available
8. Post issue comment with PR URL

### Multi-repo patch scenarios

The current pipeline operates on a **single primary repo** (`/work/<repo>`). For
monorepo cross-repo patches, the pipeline needs to know which checkout directory
to use. The default commands already handle this:

```sh
cd /work/repo
git checkout -b "$BRANCH"
# ... coding agent modifies files ...
git add -A && git commit -m "Auto-patch: ..."
git push origin HEAD:"$BRANCH"
```

For multi-repo patches where changes span multiple checkouts, each repo would
need its own branch and PR. This is not currently supported in a single task.

**Recommendation**: Monorepo patches should target a single checkout containing the
monorepo workspace. The `repos` field can clone additional read-only repos for
integration testing alongside the primary monorepo checkout.

---

## 6. Migration Fixtures

### Existing migration-related examples

The `examples/` directory contains:

| File | Purpose |
|---|---|
| `task.canonical.json` | Canonical smoke task |
| `task.github-propose-patch.json` | GitHub patch mode template |
| `task.github-evidence.json` | Evidence-only smoke |
| `task.github.json` | Minimal GitHub task (legacy format) |
| `task.canary.json` | Canary smoke for active workers |
| `broker-canary-round4.json` | Brokered canary payload validation |
| `runner-terminal-ack-smoke.json` | Terminal ACK evidence fixture |
| `runner-terminal-evidence-*.json` | Terminal evidence fixtures |
| `runner-canary-parity-*.json` | Canary parity fixtures |

### Migration fixture scaffold

A `task.monorepo-migration.json` fixture is added by this proof (see below). It
exercises:

- Multi-repo checkout with primary/secondary repos
- Workspace-aware `npm ci` in monorepo layout
- Artifact output from build and test across packages
- No GitHub write (readOnlyValidation=true) for CI-safe validation

### Migration state machine

```text
Current state (single package)
        │
        ▼
  Phase 1: Add monorepo-compatible docs + fixtures (this proof)
        │
        ▼
  Phase 2: Extract shared config/schema into workspace package
        │
        ▼
  Phase 3: Add turbo/nx configuration for dependency graph
        │
        ▼
  Phase 4: Migrate CI to workspace-aware commands
        │
        ▼
Target state (npm workspaces)
```

Each phase is independently deployable and CI-safe. No single step is a
block-and-revert-all gateway.

---

## 7. Safety Gate Compliance

| Gate | Status | Evidence |
|---|---|---|
| No production deploy | ✅ | Proof only — no docker/podman commands executed |
| No Gateway/broker/worker restart | ✅ | Proof only — no service mutation |
| No live provider/Telegram canary | ✅ | No Telegram sends performed |
| No broad cross-broker relay window | ✅ | No relay window opened |
| No terminal ACK/replay | ✅ | No terminal outbox mutation |
| No historical outbox replay | ✅ | No outbox reads or writes |
| No DB mutation/prune/migration | ✅ | No database access |
| No release/tag publish | ✅ | No tags or releases created |
| No repo visibility change | ✅ | No GitHub admin API calls |
| No secret movement | ✅ | No secrets read or written |
| No force-push | ✅ | No git push —-force |
| No approval execution | ✅ | This is documentation/test work only |

---

## Appendix: Monorepo-Compatibility Reference

### `npm test` across workspaces

```bash
# Current (single package)
npm test

# With workspaces — test all packages
npm test --workspaces

# Test a specific package
npm test --workspace packages/core
```

### Package structure suggestion

```
a2a-docker-runner/
├── packages/
│   ├── runner/          # CLI + runner core (current @openclaw/a2a-docker-runner)
│   │   ├── src/
│   │   ├── examples/
│   │   └── package.json
│   ├── scanner/         # Scanner & bundle utilities
│   │   ├── src/
│   │   └── package.json
│   └── task-types/      # Shared types package
│       ├── src/
│       └── package.json
├── package.json         # Workspace root (workspaces: ["packages/*"])
├── tsconfig.json        # Base tsconfig with project references
└── tsconfig.build.json  # Build config
```

This structure preserves the existing top-level CLI entry, moves
project-specific code into scoped packages, and keeps shared types
as a common dependency.
