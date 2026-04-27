#!/usr/bin/env bash
# setup-axl.sh — generate per-agent ed25519 keys, build the AXL image,
# start the AXL nodes, and print the peer IDs to copy into .env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYS_DIR="$REPO_ROOT/keys"

if ! command -v docker &>/dev/null; then
  echo "❌  docker is required." >&2; exit 1
fi
if ! command -v curl &>/dev/null; then
  echo "❌  curl is required." >&2; exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "❌  jq is required. Install via: brew install jq" >&2; exit 1
fi

echo ""
echo "=== SwarmNet AXL Setup ==="
echo ""

# ── 1. Find an openssl binary that supports ed25519 ──────────────────────────
# macOS ships LibreSSL which does NOT support ed25519 in genpkey.
# Try Homebrew's openssl first, fall back to system openssl.
OPENSSL_BIN="openssl"
if ! openssl genpkey -algorithm ed25519 -out /dev/null 2>/dev/null; then
  BREW_OPENSSL="$(brew --prefix openssl 2>/dev/null)/bin/openssl"
  if [ -x "$BREW_OPENSSL" ] && "$BREW_OPENSSL" genpkey -algorithm ed25519 -out /dev/null 2>/dev/null; then
    OPENSSL_BIN="$BREW_OPENSSL"
    echo "ℹ️   Using Homebrew openssl: $OPENSSL_BIN"
  else
    echo "❌  No openssl with ed25519 support found." >&2
    echo "    macOS LibreSSL does not support ed25519." >&2
    echo "    Fix: brew install openssl" >&2
    exit 1
  fi
fi

# ── 2. Generate per-agent ed25519 private keys ────────────────────────────────
echo "--- Generating ed25519 private keys in keys/ ---"
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

for AGENT in planner researcher critic executor; do
  KEY_FILE="$KEYS_DIR/${AGENT}.pem"
  if [ -f "$KEY_FILE" ]; then
    echo "  $AGENT: key exists (skipping) — delete $KEY_FILE to regenerate"
  else
    "$OPENSSL_BIN" genpkey -algorithm ed25519 -out "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "  $AGENT: generated $KEY_FILE"
  fi
done
echo ""

# ── 3. Build the AXL Docker image ─────────────────────────────────────────────
echo "--- Building axl:latest from axl.Dockerfile ---"
echo "(This clones and compiles the AXL source — takes ~2 min on first run)"
docker compose --project-directory "$REPO_ROOT" build axl-base
echo ""

# ── 4. Start AXL nodes ────────────────────────────────────────────────────────
echo "--- Starting AXL nodes ---"
docker compose --project-directory "$REPO_ROOT" up -d \
  axl-planner axl-researcher axl-critic axl-executor

echo "Waiting for nodes to come up (up to 60s)..."
WAIT=0
until \
  curl -sf http://localhost:8081/topology > /dev/null 2>&1 && \
  curl -sf http://localhost:8082/topology > /dev/null 2>&1 && \
  curl -sf http://localhost:8083/topology > /dev/null 2>&1 && \
  curl -sf http://localhost:8084/topology > /dev/null 2>&1; do
  sleep 2
  WAIT=$((WAIT + 2))
  if [ "$WAIT" -ge 60 ]; then
    echo "❌  Timed out waiting for AXL nodes." >&2
    echo "    Check logs: docker compose logs axl-planner" >&2
    exit 1
  fi
done
echo ""

# ── 5. Fetch and display peer IDs ─────────────────────────────────────────────
echo "--- Peer IDs (copy these into your .env) ---"
echo ""

PLANNER_ID=$(curl -sf http://localhost:8081/topology | jq -r '.our_public_key')
RESEARCHER_ID=$(curl -sf http://localhost:8082/topology | jq -r '.our_public_key')
CRITIC_ID=$(curl -sf http://localhost:8083/topology | jq -r '.our_public_key')
EXECUTOR_ID=$(curl -sf http://localhost:8084/topology | jq -r '.our_public_key')

printf "PLANNER_PEER_ID=%s\n"    "$PLANNER_ID"
printf "RESEARCHER_PEER_ID=%s\n" "$RESEARCHER_ID"
printf "CRITIC_PEER_ID=%s\n"     "$CRITIC_ID"
printf "EXECUTOR_PEER_ID=%s\n"   "$EXECUTOR_ID"
echo ""
echo "✅  Setup complete. Fill in the values above in .env, then run:"
echo "    docker compose up --build"
