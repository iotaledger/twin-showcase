#!/usr/bin/env bash
# Tail logs from a TWIN node container.
#
# Usage:
#   scripts/twin/logs.sh          # follow alpha
#   scripts/twin/logs.sh beta     # follow beta
#   scripts/twin/logs.sh bootstrap-alpha   # follow a one-shot bootstrap container

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

target="${1:-alpha}"
case "$target" in
  alpha)            svc="twin-node-alpha" ;;
  beta)             svc="twin-node-beta" ;;
  bootstrap-alpha)  svc="twin-bootstrap-alpha" ;;
  bootstrap-beta)   svc="twin-bootstrap-beta" ;;
  *)
    err "Unknown target '$target'. Choose: alpha | beta | bootstrap-alpha | bootstrap-beta"
    exit 1 ;;
esac

info "Following logs for $svc (Ctrl+C to stop)..."
exec "${DC[@]}" logs -f --tail=50 "$svc"
