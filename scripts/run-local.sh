#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANTHOSH_HOME="${SANTHOSH_HOME:-"$ROOT/.santhosh-local"}"
DASHBOARD_HOST="${SANTHOSH_DASHBOARD_HOST:-127.0.0.1}"
DASHBOARD_PORT="${SANTHOSH_DASHBOARD_PORT:-8732}"
TICK_INTERVAL_MS="${SANTHOSH_TICK_INTERVAL_MS:-15000}"
LISTEN_ADDR="${SANTHOSH_LISTEN_ADDR:-/ip4/0.0.0.0/tcp/0}"
BOOTSTRAP_JSON="[]"

if [ -n "${SANTHOSH_BOOTSTRAP:-}" ]; then
  BOOTSTRAP_JSON="$(printf '%s' "$SANTHOSH_BOOTSTRAP" | bun -e '
const input = await new Response(Bun.stdin.stream()).text();
const addrs = input.split(",").map((s) => s.trim()).filter(Boolean);
console.log(JSON.stringify(addrs));
')"
fi

mkdir -p "$SANTHOSH_HOME"

cat > "$SANTHOSH_HOME/config.json" <<JSON
{
  "listen": ["$LISTEN_ADDR"],
  "bootstrap": $BOOTSTRAP_JSON,
  "enableMdns": true,
  "initialTopics": ["santhosh/v1/general"],
  "tickIntervalMs": $TICK_INTERVAL_MS,
  "maxHeadersPerTick": 20,
  "soloSeedIntervalMs": 60000,
  "maxSeedsPerTick": 1,
  "dashboard": {
    "enabled": true,
    "host": "$DASHBOARD_HOST",
    "port": $DASHBOARD_PORT
  }
}
JSON

cat <<TEXT
Starting Santhosh locally
  home:      $SANTHOSH_HOME
  dashboard: http://$DASHBOARD_HOST:$DASHBOARD_PORT
  listen:    $LISTEN_ADDR
  bootstrap: ${SANTHOSH_BOOTSTRAP:-}
  tick:      ${TICK_INTERVAL_MS}ms

Stop with Ctrl-C.

TEXT

cd "$ROOT"
exec env SANTHOSH_HOME="$SANTHOSH_HOME" bun run packages/cli/src/index.ts
