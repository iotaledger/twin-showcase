#!/usr/bin/env bash
# Stop the TWIN node runtime stack. Volumes are preserved so a subsequent
# `twin:up` resumes from the existing engine state without re-bootstrapping.
#
# Usage: scripts/twin/down.sh

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

info "Stopping TWIN node containers (volumes preserved)..."
"${DC[@]}" down >/dev/null
ok "Stopped. Engine state and MySQL data are kept in Docker volumes."
info "To wipe all state (re-bootstrap required): ${C_DIM}npm run twin:reset${C_RESET}"
