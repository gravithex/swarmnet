#!/usr/bin/env bash
# demo.sh — run a SwarmNet scenario.
#
# MODES
#   manual (default)  — POST a goal to the Planner and follow it to completion.
#   sentinel          — Watch for an autonomous task triggered by the Planner
#                       sentinel (no manual goal needed). Requires SENTINEL_DEMO_MODE=true
#                       or a funded TREASURY_ADDRESS in .env.
#
# USAGE
#   ./scripts/demo.sh                          # manual, default goal
#   GOAL="Swap 0.05 ETH to USDC" ./scripts/demo.sh
#   ./scripts/demo.sh --sentinel               # sentinel / autonomous mode
#
set -euo pipefail

PLANNER_URL="${PLANNER_URL:-http://localhost:3001}"
RESEARCHER_URL="${RESEARCHER_URL:-http://localhost:3002}"
CRITIC_URL="${CRITIC_URL:-http://localhost:3003}"
EXECUTOR_URL="${EXECUTOR_URL:-http://localhost:3004}"

GOAL="${GOAL:-Swap 500 USDC to WETH with max 0.3% slippage}"
MODE="manual"
TIMEOUT_SECS=120
POLL_INTERVAL=2
HEALTH_WAIT_SECS=30

for arg in "$@"; do
  case $arg in
    --sentinel) MODE="sentinel" ;;
  esac
done

# ── dependency check ──────────────────────────────────────────────────────────
for cmd in curl jq; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "❌  $cmd is required but not installed." >&2; exit 1
  fi
done

# ── helpers ───────────────────────────────────────────────────────────────────
log() { echo "[$(date +%H:%M:%S)] $*"; }

wait_healthy() {
  local emoji=$1 name=$2 url=$3
  local attempts=0
  printf "%s %s: waiting for health" "$emoji" "$name"
  until curl -sf "${url}/health" > /dev/null 2>&1; do
    printf "."
    sleep 1
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$HEALTH_WAIT_SECS" ]; then
      printf " ❌\n"
      log "Timed out waiting for ${name} at ${url}/health" >&2
      exit 1
    fi
  done
  printf " ✅\n"
}

# Follow a task ID to completion, printing phase transitions.
follow_task() {
  local task_id=$1
  local start elapsed phase last_phase=""
  start=$(date +%s)

  while true; do
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$TIMEOUT_SECS" ]; then
      echo ""
      log "❌  Timeout after ${TIMEOUT_SECS}s — taskId=${task_id}" >&2
      exit 1
    fi

    local status_json phase
    status_json=$(curl -sf "${PLANNER_URL}/status/${task_id}" 2>/dev/null || echo '{"phase":"unknown"}')
    phase=$(echo "$status_json" | jq -r '.phase // "unknown"')

    if [ "$phase" != "$last_phase" ]; then
      case "$phase" in
        planning)
          log "🧠 Planner: LLM parsing goal — extracting strategy, tokens, risk tolerance..."
          ;;
        researching)
          log "🔍 Researcher: fetching Uniswap quote, pool depth, gas estimate..."
          ;;
        critiquing)
          log "🧐 Critic: LLM reasoning — analyzing price impact, sandwich risk, route quality..."
          ;;
        executing)
          log "⚡ Executor: triggering KeeperHub webhook, polling execution status..."
          ;;
        done)
          local execution_id
          execution_id=$(echo "$status_json" | jq -r '.executionId // "(none)"')
          echo ""
          log "✅  Execution confirmed in ${elapsed}s"
          echo "    taskId:      ${task_id}"
          echo "    executionId: ${execution_id}"
          echo ""
          echo "  Audit trail stored in 0G Storage:"
          echo "    plan:${task_id}"
          echo "    research:${task_id}"
          echo "    critique:${task_id}"
          echo "    execution:${task_id}"
          echo "=============================="
          exit 0
          ;;
        rejected)
          local reason
          reason=$(echo "$status_json" | jq -r '.reason // "unknown"')
          echo ""
          log "🧐 Critic: REJECTED — ${reason}" >&2
          exit 1
          ;;
        error)
          local err
          err=$(echo "$status_json" | jq -r '.error // "unknown"')
          echo ""
          log "❌  Error — ${err}" >&2
          exit 1
          ;;
      esac
      last_phase="$phase"
    fi

    sleep "$POLL_INTERVAL"
  done
}

# ── wait for all agents ───────────────────────────────────────────────────────
echo ""
echo "=============================="
echo "  SwarmNet Demo — ${MODE} mode"
echo "=============================="
echo ""
echo "--- Waiting for agents ---"
wait_healthy "🧠" "Planner"    "$PLANNER_URL"
wait_healthy "🔍" "Researcher" "$RESEARCHER_URL"
wait_healthy "🧐" "Critic"     "$CRITIC_URL"
wait_healthy "⚡" "Executor"   "$EXECUTOR_URL"
echo ""

# ── manual mode ───────────────────────────────────────────────────────────────
if [ "$MODE" = "manual" ]; then
  echo "--- Submitting goal ---"
  log "Goal: ${GOAL}"
  echo ""

  SUBMIT_RESP=$(curl -sf -X POST "${PLANNER_URL}/goal" \
    -H "Content-Type: application/json" \
    -d "{\"goal\": $(echo "$GOAL" | jq -Rs .)}")

  TASK_ID=$(echo "$SUBMIT_RESP" | jq -r '.taskId // empty')
  if [ -z "$TASK_ID" ]; then
    log "❌  No taskId returned — response: ${SUBMIT_RESP}" >&2; exit 1
  fi

  log "🧠 Task created — taskId=${TASK_ID}"
  echo ""
  echo "--- Tracking progress ---"
  follow_task "$TASK_ID"
fi

# ── sentinel mode ─────────────────────────────────────────────────────────────
if [ "$MODE" = "sentinel" ]; then
  echo "--- Sentinel mode: waiting for autonomous task ---"
  echo "    (Planner is monitoring the treasury wallet)"
  echo "    Tip: set SENTINEL_DEMO_MODE=true in .env to trigger without real Sepolia ETH."
  echo ""

  SENTINEL_WAIT=90
  start=$(date +%s)

  while true; do
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$SENTINEL_WAIT" ]; then
      log "❌  No autonomous task triggered after ${SENTINEL_WAIT}s." >&2
      log "    Check TREASURY_ADDRESS and SENTINEL_DEMO_MODE in your .env." >&2
      exit 1
    fi

    # Poll /status/:taskId is per-task; we need to detect any NEW task.
    # We do this by calling GET /health and checking logs, or simply asking
    # the sentinel to emit to a known probe key. For now we use a small trick:
    # submit an empty probe that returns the latest task if any.
    PROBE=$(curl -sf "${PLANNER_URL}/health" 2>/dev/null | jq -r '.latestTaskId // empty' 2>/dev/null || true)
    if [ -n "$PROBE" ]; then
      log "🧠 Sentinel: autonomous task detected — taskId=${PROBE}"
      echo ""
      echo "--- Tracking progress ---"
      follow_task "$PROBE"
      break
    fi

    printf "."
    sleep 2
  done
fi
