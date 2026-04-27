#!/usr/bin/env bash
# check-health.sh — verify all four SwarmNet agents are reachable and healthy.
set -uo pipefail

PLANNER_URL="${PLANNER_URL:-http://localhost:3001}"
RESEARCHER_URL="${RESEARCHER_URL:-http://localhost:3002}"
CRITIC_URL="${CRITIC_URL:-http://localhost:3003}"
EXECUTOR_URL="${EXECUTOR_URL:-http://localhost:3004}"

TIMEOUT="${HEALTH_TIMEOUT:-5}"

if ! command -v curl &> /dev/null; then
  echo "❌  curl is required but not installed." >&2; exit 1
fi

# ── check one agent ───────────────────────────────────────────────────────────
check() {
  local emoji=$1 name=$2 url=$3
  local http_code
  http_code=$(curl -so /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "${url}/health" 2>/dev/null || echo "000")
  if [ "$http_code" = "200" ]; then
    echo "✅  ${emoji} ${name} — ${url}/health (HTTP ${http_code})"
    return 0
  else
    echo "❌  ${emoji} ${name} — ${url}/health (HTTP ${http_code})"
    return 1
  fi
}

# ── run all checks ────────────────────────────────────────────────────────────
echo ""
echo "=== SwarmNet Health Check ==="
echo ""

ALL_OK=true

check "🧠" "Planner    " "$PLANNER_URL"    || ALL_OK=false
check "🔍" "Researcher " "$RESEARCHER_URL" || ALL_OK=false
check "🧐" "Critic     " "$CRITIC_URL"     || ALL_OK=false
check "⚡" "Executor   " "$EXECUTOR_URL"   || ALL_OK=false

echo ""
if [ "$ALL_OK" = "true" ]; then
  echo "All agents healthy ✅"
  exit 0
else
  echo "One or more agents are unhealthy ❌" >&2
  exit 1
fi
