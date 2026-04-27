#!/usr/bin/env bash
# demo.sh — submit a goal to the SwarmNet planner and follow it to completion.
set -euo pipefail

PLANNER_URL="${PLANNER_URL:-http://localhost:3001}"
RESEARCHER_URL="${RESEARCHER_URL:-http://localhost:3002}"
CRITIC_URL="${CRITIC_URL:-http://localhost:3003}"
EXECUTOR_URL="${EXECUTOR_URL:-http://localhost:3004}"

GOAL="${GOAL:-Swap 500 USDC to WETH with max 0.3% slippage}"
TIMEOUT_SECS=60
POLL_INTERVAL=2
HEALTH_WAIT_SECS=30

# ── dependency check ──────────────────────────────────────────────────────────
if ! command -v curl &> /dev/null; then
  echo "❌  curl is required but not installed." >&2; exit 1
fi
if ! command -v jq &> /dev/null; then
  echo "❌  jq is required but not installed. Install via: brew install jq" >&2; exit 1
fi

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

# ── wait for all agents ───────────────────────────────────────────────────────
echo ""
echo "=== SwarmNet Demo ==="
echo "Goal: ${GOAL}"
echo ""
echo "--- Waiting for agents to be healthy ---"
wait_healthy "🧠" "Planner"    "$PLANNER_URL"
wait_healthy "🔍" "Researcher" "$RESEARCHER_URL"
wait_healthy "🧐" "Critic"     "$CRITIC_URL"
wait_healthy "⚡" "Executor"   "$EXECUTOR_URL"
echo ""

# ── submit goal ───────────────────────────────────────────────────────────────
echo "--- Submitting goal ---"
SUBMIT_RESP=$(curl -sf -X POST "${PLANNER_URL}/goal" \
  -H "Content-Type: application/json" \
  -d "{\"goal\": $(echo "$GOAL" | jq -Rs .)}")

TASK_ID=$(echo "$SUBMIT_RESP" | jq -r '.taskId // empty')
if [ -z "$TASK_ID" ]; then
  log "❌  Failed to get taskId — response: ${SUBMIT_RESP}" >&2; exit 1
fi

log "🧠 Planner: task created — taskId=${TASK_ID}"
echo ""
echo "--- Tracking progress ---"

# ── poll status ───────────────────────────────────────────────────────────────
START_TIME=$(date +%s)
LAST_PHASE=""

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START_TIME ))

  if [ "$ELAPSED" -ge "$TIMEOUT_SECS" ]; then
    echo ""
    log "❌  Timeout after ${TIMEOUT_SECS}s — taskId=${TASK_ID}" >&2
    exit 1
  fi

  STATUS_JSON=$(curl -sf "${PLANNER_URL}/status/${TASK_ID}" 2>/dev/null \
    || echo '{"phase":"unknown"}')
  PHASE=$(echo "$STATUS_JSON" | jq -r '.phase // "unknown"')

  if [ "$PHASE" != "$LAST_PHASE" ]; then
    case "$PHASE" in
      planning)
        log "🧠 Planner: decomposing goal into tasks..."
        ;;
      researching)
        log "🔍 Researcher: fetching Uniswap quote (USDC → WETH)..."
        ;;
      critiquing)
        log "🧐 Critic: validating research data and scoring confidence..."
        ;;
      executing)
        log "⚡ Executor: submitting transaction via KeeperHub..."
        ;;
      done)
        TX_HASH=$(echo "$STATUS_JSON" | jq -r '.txHash // "(none)"')
        log "⚡ Executor: transaction confirmed!"
        echo ""
        echo "=============================="
        echo "✅  Task complete in ${ELAPSED}s"
        echo "    txHash: ${TX_HASH}"
        echo "    taskId: ${TASK_ID}"
        echo "=============================="
        exit 0
        ;;
      rejected)
        REASON=$(echo "$STATUS_JSON" | jq -r '.reason // "unknown"')
        echo ""
        log "🧐 Critic: task rejected — ${REASON}" >&2
        exit 1
        ;;
      error)
        ERR=$(echo "$STATUS_JSON" | jq -r '.error // "unknown"')
        echo ""
        log "❌  Error — ${ERR}" >&2
        exit 1
        ;;
    esac
    LAST_PHASE="$PHASE"
  fi

  sleep "$POLL_INTERVAL"
done
