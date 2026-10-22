#!/usr/bin/env bash
# Shared helpers for scripts/twin/*.sh.

set -euo pipefail

# Project root = parent of scripts/twin
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.twin.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Error: $COMPOSE_FILE not found." >&2
  exit 1
fi

# `docker compose` v2 only (the deprecated `docker-compose` is not supported).
if ! docker compose version >/dev/null 2>&1; then
  echo "Error: 'docker compose' v2 is required." >&2
  exit 1
fi

DC=(docker compose -f "$COMPOSE_FILE")

# Color helpers — only enabled on a TTY.
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

info()  { printf "%s[twin]%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf "%s[twin]%s %s%s%s\n" "$C_GREEN" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn()  { printf "%s[twin]%s %s%s%s\n" "$C_YELLOW" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET" >&2; }
err()   { printf "%s[twin]%s %s%s%s\n" "$C_RED" "$C_RESET" "$C_RED" "$*" "$C_RESET" >&2; }

# Wait until `url` returns 2xx, polling every `interval_s`, with a `timeout_s`.
# Usage: wait_http <url> <timeout_s> <interval_s>
wait_http() {
  local url="$1" timeout="${2:-60}" interval="${3:-3}"
  local elapsed=0
  while ! curl -fsS -o /dev/null --max-time 2 "$url"; do
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 0
}

# Return 0 if a container with the given name is running.
container_running() {
  local name="$1"
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ]
}

# Extract the first DID found in the engine-state.json of the given container.
# Returns empty string if the file or DID is not present.
container_did() {
  local name="$1"
  docker exec "$name" sh -c \
    "grep -o 'did:iota:testnet:0x[a-f0-9]*' /var/lib/twin/engine-state.json 2>/dev/null | head -1" \
    2>/dev/null || true
}

# Read the tenant API key for a node from data/tenant-state.json. Empty
# string if the file or the node entry is missing. In multi-tenant mode
# (TWIN_TENANT_ENABLED=true, the default since T-314) every REST call —
# including POST /authentication/login — requires this key in `x-api-key`.
tenant_api_key() {
  local node="$1"
  node -e "try{const s=require('$ROOT/data/tenant-state.json');process.stdout.write((s.nodes&&s.nodes['$node']&&s.nodes['$node'].tenantApiKey)||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true
}

# Read a container's State.Health.Status (e.g. "healthy", "starting", "none").
# Returns "missing" if the container doesn't exist.
container_health() {
  local name="$1"
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$name" 2>/dev/null || echo missing
}

# Start one or more compose services WITHOUT triggering the docker compose
# v2 "up -d hang" bug. compose's `up -d` regularly blocks indefinitely on
# the start phase under Docker Desktop CLI plugin 5.1.x. We instead:
#   1. `compose create` (just allocates container/network/volume),
#   2. `docker start` each container directly via the daemon.
#
# Usage: compose_start_services <compose-name>:<container-name> [more...]
# Example: compose_start_services twin-node-alpha:twin-showcase-node-alpha
compose_start_services() {
  local pair svc container current
  local svcs=() containers=()
  for pair in "$@"; do
    svcs+=("${pair%%:*}")
    containers+=("${pair##*:}")
  done

  "${DC[@]}" create "${svcs[@]}" >/dev/null

  local i
  for i in "${!containers[@]}"; do
    container="${containers[$i]}"
    current="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)"
    case "$current" in
      running) ;;  # already up; nothing to do
      created|exited|paused|"")
        docker start "$container" >/dev/null ;;
      missing)
        err "container '$container' was not created — check the compose file."
        return 1 ;;
      *)
        docker start "$container" >/dev/null ;;
    esac
  done
}

# Wait until a container's health is "healthy", polling every `interval_s`,
# up to `timeout_s`. Prints a single-line status that overwrites itself
# every poll so the user sees real-time feedback during the wait.
# Returns 0 on healthy, 1 on timeout.
wait_container_healthy() {
  local name="$1" timeout="${2:-120}" interval="${3:-3}"
  local elapsed=0 status
  while true; do
    status="$(container_health "$name")"
    case "$status" in
      healthy)
        # Clear the in-place line, then print final ok message.
        printf "\r\033[K"
        return 0 ;;
      missing)
        printf "\r\033[K"
        err "container '$name' disappeared while waiting for health"
        return 1 ;;
    esac
    if [ "$elapsed" -ge "$timeout" ]; then
      printf "\r\033[K"
      return 1
    fi
    # \r returns to line start; ESC[K clears to end-of-line. Keeps the
    # progress message on a single, in-place updating line.
    printf "%s[twin]%s waiting on %s (health=%s, %ss elapsed)\r" \
      "$C_DIM" "$C_RESET" "$name" "$status" "$elapsed"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
}
