#!/usr/bin/env bash
# Bootstrap one or both TWIN nodes. Each bootstrap:
#   1. brings up the node's MySQL container and waits for healthy
#   2. runs the `twin-bootstrap-<node>` one-shot container which creates a
#      node DID, an org DID, an admin-user DID on IOTA testnet, funds a
#      wallet from the faucet, and writes engine-state.json to the volume
#   3. on success the bootstrap container exits and is removed
#
# Usage:
#   scripts/twin/bootstrap.sh              # bootstrap both alpha and beta
#   scripts/twin/bootstrap.sh alpha        # only alpha
#   scripts/twin/bootstrap.sh beta         # only beta
#   scripts/twin/bootstrap.sh --skip-existing  # skip a node that is already bootstrapped
#
# The bootstrap performs network calls to api.testnet.iota.cafe and the
# faucet. Expected duration: 30-90s per node on a healthy testnet. If you
# see no progress for >2 minutes, check the testnet status and inspect
# the live logs in another shell:
#   docker compose -f docker-compose.twin.yml logs -f
#
# Re-running the script for an already-bootstrapped node will start a
# second IOTA identity and may waste faucet tokens unless --skip-existing
# is passed.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

NODES=()
SKIP_EXISTING=0
for arg in "$@"; do
  case "$arg" in
    alpha|beta) NODES+=("$arg") ;;
    --skip-existing) SKIP_EXISTING=1 ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      err "Unknown argument: $arg"
      exit 1 ;;
  esac
done
[ ${#NODES[@]} -eq 0 ] && NODES=(alpha beta)

bootstrap_node() {
  local node="$1"
  local container="twin-showcase-node-$node"
  local svc="twin-bootstrap-$node"
  local db_container="twin-showcase-db-$node"

  info "[$node] checking current state..."
  if container_running "$container"; then
    local did
    did="$(container_did "$container")"
    if [ -n "$did" ]; then
      if [ "$SKIP_EXISTING" -eq 1 ]; then
        ok   "[$node] already bootstrapped ($did). Skipping (--skip-existing)."
        return 0
      fi
      warn "[$node] already bootstrapped ($did). Re-running bootstrap will create a NEW identity on testnet."
      warn "[$node] If that is intentional, run scripts/twin/reset.sh first to wipe the state cleanly."
    fi
  fi

  # Step 1: bring up MySQL via compose_start_services (avoids the
  # docker compose v2 'up -d hang' bug — see helper in _common.sh).
  info "[$node] preparing MySQL dependency ($db_container)..."
  compose_start_services "db-$node:$db_container"

  info "[$node] waiting for MySQL to become healthy..."
  if ! wait_container_healthy "$db_container" 120 3; then
    err "[$node] MySQL did not become healthy within 120s. Last logs:"
    docker logs --tail=30 "$db_container" 2>&1 >&2 || true
    return 1
  fi
  ok "[$node] MySQL is healthy."

  # Step 2: run the one-shot bootstrap container.
  #
  # We deliberately do NOT use `docker compose run --rm`. It allocates an
  # interactive TTY for stdin, and under Docker Desktop the resulting
  # container regularly gets stuck in 'Created' state with an orphan
  # stdin descriptor — once that happens even `docker rm -f` and
  # `docker start` hang against the wedged container, forcing a full
  # Docker Desktop restart.
  #
  # Instead:
  #   1. `compose create` allocates the container (no TTY, no start).
  #   2. `docker start -a` starts it AND streams its output (no TTY,
  #      stdin closed) — we still see the spinner / mnemonic / DID lines.
  #   3. `docker rm` removes the container after exit (mimics --rm).

  info "[$node] preparing bootstrap container ($svc)..."
  local start_ts
  start_ts="$(date +%s)"
  # Note: `docker compose create` doesn't support --no-deps. Since we just
  # ensured the db dependency is up + healthy via compose_start_services,
  # compose will reuse the existing container without recreating it.
  if ! "${DC[@]}" create "$svc" >/dev/null; then
    err "[$node] failed to create the bootstrap container."
    return 1
  fi

  # `compose create` names the container <project>-<service>-1 (consistent
  # with docker compose v2). Resolve it dynamically rather than guessing.
  local boot_container
  boot_container="$(docker ps -a --filter "label=com.docker.compose.service=$svc" --filter "label=com.docker.compose.project=twin-showcase" --format '{{.Names}}' | head -1)"
  if [ -z "$boot_container" ]; then
    err "[$node] could not locate the created bootstrap container."
    return 1
  fi

  info "[$node] running bootstrap (creates DID + funds wallet on IOTA testnet, expect 30-90s)..."
  info "[$node] live output below — safe to Ctrl+C; the container is removed after the run:"
  echo

  local boot_rc=0
  docker start -a "$boot_container" || boot_rc=$?
  echo
  docker rm -f "$boot_container" >/dev/null 2>&1 || true

  if [ "$boot_rc" -ne 0 ]; then
    err "[$node] bootstrap failed (exit $boot_rc). See output above."
    return 1
  fi

  # Step 3: bring up the runtime via the same workaround helper and read
  # back the persisted DID.
  compose_start_services "twin-node-$node:$container"
  wait_http "http://localhost:$( [ "$node" = "alpha" ] && echo 3000 || echo 3001 )/health" 60 3 || true

  local did
  did="$(container_did "$container")"
  local elapsed=$(($(date +%s) - start_ts))
  if [ -n "$did" ]; then
    ok "[$node] bootstrap complete in ${elapsed}s. Node DID: $did"
    # The DID publish transaction is the canonical proof the wallet was
    # funded — without faucet tokens the bootstrap container would have
    # failed before reaching engine-state.json. Surface it explicitly so
    # the operator doesn't have to re-derive the chain of reasoning.
    ok "[$node] wallet funded by faucet (proof: DID anchored on IOTA testnet)"
  else
    warn "[$node] bootstrap finished in ${elapsed}s but no DID found in engine-state.json (yet). Run npm run twin:status to inspect."
  fi
}

for node in "${NODES[@]}"; do
  bootstrap_node "$node"
done

info ""
info "Next: ${C_DIM}npm run twin:up${C_RESET} (start runtime), or ${C_DIM}npm run twin:status${C_RESET} (check state)"
