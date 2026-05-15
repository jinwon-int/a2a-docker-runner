# OpenClaw All-Node Latency Check (A2A R24)

Target nodes: `nosuk` / `vps2` (reusable docker-runner latency check template)

Issue: [a2a-docker-runner#265](https://github.com/jinwon-int/a2a-docker-runner/issues/265)
Parent: [a2a-plane#343](https://github.com/jinwon-int/a2a-plane/issues/343)
Run: `a2a-r24-openclaw-latency-optimization-20260515T0655Z`

## Purpose

Collect OpenClaw runtime diagnostics across all active nodes for latency
optimization analysis. The collector gathers:

- OpenClaw version and runtime metadata
- Health/ready/event-loop status
- Recent latency logs
- Session-store residue (stale sessions)
- A2A task backlog
- Plugin/provider discovery drift

## Template Usage

The built-in template `openclaw-latency-check` can be referenced via
`task.template` in any runner task:

### Via task.template reference

```json
{
  "id": "latency-check-nosuk-001",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "template": "openclaw-latency-check",
  "templateVars": {
    "TARGET_NODE": "nosuk"
  },
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/265",
  "requestedBy": "seoseo",
  "timeoutMs": 180000,
  "forbidNewPr": true,
  "allowNoChanges": true
}
```

### Via inline template

```json
{
  "id": "latency-check-vps2-001",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "template": "openclaw-latency-check",
  "templateVars": {
    "TARGET_NODE": "vps2",
    "EVIDENCE_PREFIX": "vps2-latency"
  },
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/265",
  "forbidNewPr": true,
  "allowNoChanges": true,
  "timeoutMs": 180000
}
```

### Manual execution on target

```bash
# Directly on the target node:
openclaw --version
openclaw status
openclaw status --deep
openclaw gateway probe
openclaw logs 10

# Session store:
ls -la ~/.openclaw/agents/main/sessions/

# Provider discovery:
openclaw status --deep | grep -iE "provider|plugin|channel"

# A2A backlog:
cat /var/lib/openclaw-a2a/tasks/*/task.json 2>/dev/null | head -50
```

## Expected Artifacts

After the latency check template runs, these artifacts are written to
`/work/artifacts/` (with `${EVIDENCE_PREFIX}` defaulting to `latency-check`):

| Artifact | Content |
|---|---|
| `${PREFIX}-version.txt` | `openclaw --version` output |
| `${PREFIX}-status.txt` | `openclaw status` output |
| `${PREFIX}-deep-status.txt` | `openclaw status --deep` output |
| `${PREFIX}-gateway-probe.txt` | Gateway health probe result |
| `${PREFIX}-sessions.txt` | Session store directory listing |
| `${PREFIX}-logs.txt` | Recent log lines |
| `${PREFIX}-providers.txt` | Provider/plugin/channel discovery |
| `${PREFIX}-backlog.txt` | A2A task backlog (if any) |
| `${PREFIX}-evidence.json` | Structured latency check JSON |
| `${PREFIX}-runbook.md` | Sanitized markdown runbook |

## Collector Module

The `src/openclaw-latency-check.ts` module exports:

### `collectOpenClawLatencyCheck(node: string): OpenClawLatencyCheck`

Runs `openclaw status` and `openclaw status --deep` in a child process and
parses the output into a structured diagnostic report. Deterministic timestamps
and redacted output make this fixture-safe.

### `formatLatencyCheckRunbook(check: OpenClawLatencyCheck): string`

Formats the structured check result into a markdown runbook suitable for
operator review or GitHub evidence.

## Diagnostics Collected

### Runtime
- OpenClaw version and channel
- OS, Node.js version
- Gateway reachability and URL
- Active model route (e.g. `deepseek-v4-flash`)
- Agent count

### Health
- Gateway status (reachable / local_only)
- Active session count
- Memory plugin status
- Heartbeat interval
- Plugin compatibility

### Latency
- Provider round-trip time (ms)
- Gateway connect time (ms)
- Event loop lag (ms)
- Anomaly notes

### Session Store
- Session directory path
- Total session file count
- Stale session count (threshold: 24 hours)
- Stale session listing

### A2A Backlog
- Task count from deep status
- Task description lines

### Plugin/Provider Drift
- Available provider/provider-channel lines from deep status
- Registry plugin inventory

## Safety Declaration

This check template:

- ❌ Does not restart Gateway, broker, or worker
- ❌ Does not deploy or release
- ❌ Does not send provider messages (Telegram, etc.)
- ❌ Does not ACK terminal evidence
- ❌ Does not mutate production DB
- ❌ Does not prune or migrate data
- ❌ Does not move secrets or change visibility
- ✅ Collects read-only diagnostics only
- ✅ Deterministic, replay-safe timestamps
- ✅ Secret-redacted output

## Active Targets

| Node | Expected state |
|---|---|
| `bangtong` | Active runner worker |
| `dungae` | Active runner worker |
| `sogyo` | Active runner worker |
| `nosuk` | Active runner worker (target) |
| `vps2` | Legacy Yukson/VPS2 — excluded from runner rollout but in scope for latency data |
| `yukson` | **Excluded** from runner rollout |

## See Also

- [Runner integration docs](integration.md)
- [Task templates](task-templates.ts)
- [Release rollout checklist](release-rollout-checklist.md)
- [Broker health-readiness fixture](../examples/broker-health-readiness-fixture.json)
