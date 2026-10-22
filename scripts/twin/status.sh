#!/usr/bin/env bash
# Print the current state of the TWIN stack: containers, health, login
# reachability and persisted DIDs. Useful to diagnose "is the bootstrap
# still running?" / "are the nodes ready?".
#
# Usage: scripts/twin/status.sh

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

printf "%s== Containers ==%s\n" "$C_BOLD" "$C_RESET"
"${DC[@]}" ps 2>/dev/null || true
echo

check_node() {
  local node="$1" port="$2"
  local container="twin-showcase-node-$node"
  local email="admin@$node"
  local password
  password="$(grep '^TWIN_ADMIN_USER_PASSWORD=' "$ROOT/twin/$node/bootstrap.env" 2>/dev/null \
              | sed -E 's/^TWIN_ADMIN_USER_PASSWORD="?([^"]*)"?$/\1/')"

  printf "%s== %s (port %s) ==%s\n" "$C_BOLD" "$node" "$port" "$C_RESET"

  if ! container_running "$container"; then
    warn "$container is not running. Start it with: npm run twin:up"
    echo
    return
  fi

  # / (root, public — T-314: /health now requires x-api-key in multi-tenant mode)
  if curl -fsS -o /dev/null --max-time 2 "http://localhost:$port/"; then
    ok "/         200 OK"
  else
    err "/         unreachable on localhost:$port"
    echo
    return
  fi

  # login — in multi-tenant mode the node requires `x-api-key` on EVERY
  # REST call, login included (T-314). Without it the user lookup runs in
  # the wrong partition and returns a fast 401 even when the admin user is
  # correctly provisioned. Read the tenant key the anchor stage persisted
  # to data/tenant-state.json and pass it, mirroring what kitsune-client
  # does for the real adapter. The login still works without multi-tenant
  # (key empty → header omitted).
  local api_key apikey_header=()
  api_key="$(tenant_api_key "$node")"
  if [ -n "$api_key" ]; then
    apikey_header=(-H "x-api-key: $api_key")
  fi

  local login_status
  login_status="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://localhost:$port/authentication/login" \
    -H 'Content-Type: application/json' \
    "${apikey_header[@]}" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    --max-time 5 || echo "000")"
  case "$login_status" in
    200|201|204) ok "/login    $login_status (admin user ready)" ;;
    401)
      if [ -z "$api_key" ]; then
        warn "/login    401 (no tenant key in data/tenant-state.json — multi-tenant node rejects login without x-api-key; re-run npm run twin:bootstrap -- --stage=anchor)"
      else
        warn "/login    401 (admin user not provisioned OR vault auth-signing key missing — re-run npm run twin:bootstrap -- --stage=anchor)"
      fi
      ;;
    *)           warn "/login    $login_status (unexpected)" ;;
  esac

  # DID
  local did
  did="$(container_did "$container")"
  if [ -n "$did" ]; then
    ok "node DID  $did"
    # T-247: /identity/<did-with-hyphens> renders the DID document in
    # human-readable form. Replace every colon in the DID with a hyphen
    # for the URL slug; extract the network from the DID itself when
    # present, fall back to testnet.
    local did_slug="${did//:/-}"
    local did_network="testnet"
    case "$did" in
      did:iota:mainnet:*) did_network="mainnet" ;;
      did:iota:testnet:*) did_network="testnet" ;;
    esac
    info "Explorer  https://explorer.iota.org/identity/${did_slug}?network=${did_network}"
    # A DID on IOTA testnet only exists because the wallet successfully
    # paid gas for the publish transaction — so the presence of a node DID
    # is proof the faucet funded the wallet during bootstrap. The TWIN node
    # REST API does not expose a balance endpoint, so this is the canonical
    # check from outside the container.
    ok "wallet    funded (proof: DID anchored on testnet, gas was paid)"
  else
    warn "node DID  not found in engine-state.json — bootstrap may not have completed"
    warn "wallet    funding unverified (no on-chain transaction recorded yet)"
  fi
  echo
}

check_node alpha 3000
check_node beta 3001
