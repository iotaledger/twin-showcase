#!/usr/bin/env bash
# Start the TWIN node runtime stack and wait until both nodes report healthy.
#
# Usage: scripts/twin/up.sh
#
# Does not run bootstrap; if the engine state is missing, the nodes will
# exit immediately. Run scripts/twin/bootstrap.sh first in that case.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

info "Starting twin-node-alpha + twin-node-beta (and their MySQL dependencies)..."
compose_start_services \
  db-alpha:twin-showcase-db-alpha \
  db-beta:twin-showcase-db-beta \
  twin-node-alpha:twin-showcase-node-alpha \
  twin-node-beta:twin-showcase-node-beta

info "Waiting for / on alpha (port 3000)..."
# T-314: use the public root endpoint instead of /health, which now
# requires `x-api-key` when TWIN_TENANT_ENABLED=true. The root returns
# a plain "TWIN Node - <version>" with no auth.
if ! wait_http "http://localhost:3000/" 60 3; then
  err   "Alpha did not respond within 60s. Recent logs:"
  "${DC[@]}" logs --tail=20 twin-node-alpha >&2 || true
  exit 1
fi
ok "Alpha ready  -> http://localhost:3000"

info "Waiting for / on beta (port 3001)..."
if ! wait_http "http://localhost:3001/" 60 3; then
  err   "Beta did not respond within 60s. Recent logs:"
  "${DC[@]}" logs --tail=20 twin-node-beta >&2 || true
  exit 1
fi
ok "Beta  ready  -> http://localhost:3001"

cat <<EOF
${C_BOLD}Credentials${C_RESET} (from twin/{alpha,beta}/bootstrap.env):
  Alpha  admin@alpha / TwinAlpha#2026!Demo
  Beta   admin@beta  / TwinBeta#2026!Demo

Stop with:   ${C_DIM}npm run twin:down${C_RESET}
Check status: ${C_DIM}npm run twin:status${C_RESET}
EOF
