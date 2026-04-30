#!/usr/bin/env bash
# Fake a2a-docker-runner binary for CI-safe canary testing.
#
# This script simulates `a2a-docker-runner run <task.json>` output for
# PR/Done/Block/malformed/failure paths without needing Docker, a live
# broker, or GitHub mutation.
#
# Usage:
#   FAKE_RUNNER_MODE=pr      scripts/fake-runner.sh run task.json
#   FAKE_RUNNER_MODE=done    scripts/fake-runner.sh run task.json
#   FAKE_RUNNER_MODE=block   scripts/fake-runner.sh run task.json
#   FAKE_RUNNER_MODE=malformed scripts/fake-runner.sh run task.json
#   FAKE_RUNNER_MODE=failure scripts/fake-runner.sh run task.json
#
# Mode can also be set via the first positional argument when no 'run'
# subcommand is used:
#   scripts/fake-runner.sh pr
#   scripts/fake-runner.sh done
#   ...

set -euo pipefail

# Resolve mode: env var > first positional arg > "pr" default
MODE="${FAKE_RUNNER_MODE:-}"

# Allow "run" subcommand (matching real CLI) or bare mode
if [ "${1:-}" = "run" ]; then
  # Skip "run" if it's the first arg
  TASK_FILE="${2:-}"
else
  # First arg is the mode directly
  if [ -z "$MODE" ]; then
    MODE="${1:-pr}"
  fi
  TASK_FILE="${2:-}"
fi

[ -z "$MODE" ] && MODE="pr"

# Extract task ID from task JSON file if provided
TASK_ID="unknown"
if [ -n "${TASK_FILE:-}" ] && [ -f "$TASK_FILE" ]; then
  TASK_ID=$(node -e "try{const t=JSON.parse(require('fs').readFileSync('$TASK_FILE','utf8'));console.log(t.id||'unknown')}catch(e){console.log('unknown')}" 2>/dev/null || echo "unknown")
fi

WORK_DIR="/tmp/a2a-canary/${TASK_ID}"

case "$MODE" in
  pr)
    cat <<EOF
{
  "ok": true,
  "taskId": "${TASK_ID}",
  "status": "completed",
  "workDir": "${WORK_DIR}",
  "exitCode": 0,
  "signal": null,
  "stdout": "PR created: https://github.com/jinwon-int/a2a-docker-runner/pull/99\\ncanary smoke test passed",
  "stderr": "",
  "artifacts": ["${WORK_DIR}/artifacts/summary.txt", "${WORK_DIR}/artifacts/canary-result.txt"],
  "github": { "prUrl": "https://github.com/jinwon-int/a2a-docker-runner/pull/99" }
}
EOF
    exit 0
    ;;
  done)
    cat <<EOF
{
  "ok": true,
  "taskId": "${TASK_ID}",
  "status": "completed",
  "workDir": "${WORK_DIR}",
  "exitCode": 0,
  "signal": null,
  "stdout": "canary smoke test passed (no PR needed)",
  "stderr": "",
  "artifacts": ["${WORK_DIR}/artifacts/summary.txt"],
  "github": { "doneCommentUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/11#issuecomment-canary-done" }
}
EOF
    exit 0
    ;;
  block)
    cat <<EOF
{
  "ok": false,
  "taskId": "${TASK_ID}",
  "status": "failed",
  "workDir": "${WORK_DIR}",
  "exitCode": 1,
  "signal": null,
  "stdout": "",
  "stderr": "build failed: npm ERR! missing dependencies",
  "artifacts": [],
  "error": "build failed: npm ERR! missing dependencies",
  "github": { "blockCommentUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/11#issuecomment-canary-block" }
}
EOF
    exit 1
    ;;
  malformed)
    echo "this is not json { broken [ output"
    exit 0
    ;;
  failure)
    cat <<EOF
{
  "ok": false,
  "taskId": "${TASK_ID}",
  "status": "timeout",
  "workDir": "${WORK_DIR}",
  "exitCode": null,
  "signal": "SIGTERM",
  "stdout": "partial output before timeout",
  "stderr": "container timed out after 2700000ms",
  "artifacts": [],
  "error": "container timed out after 2700000ms"
}
EOF
    exit 1
    ;;
  crash)
    # Runner crashes before producing valid JSON (non-zero exit, partial write)
    echo '{"ok": false, "taskId": "'
    exit 137
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Valid modes: pr, done, block, malformed, failure, crash" >&2
    exit 2
    ;;
esac
