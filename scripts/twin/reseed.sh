#!/usr/bin/env bash
# Clean re-seed: wipe TWIN node state (volumes + DIDs), re-anchor identities
# from the EXISTING wallet bundle (no faucet call, no re-funding), bring
# the runtime up, and run the corridor seeder.
#
# This script PRESERVES the encrypted wallet bundle so DevOps doesn't need
# to re-fund every time you want a clean corridor state. The previously
# anchored DIDs are orphaned on testnet; the new ones use the same wallet.
#
# To force a full reset including the wallet bundle, run:
#   scripts/twin/reset.sh --purge-wallets
#   scripts/twin/bootstrap.sh --stage=accounts
#   # ... DevOps funds, then:
#   scripts/twin/bootstrap.sh --stage=anchor
#
# Usage:
#   scripts/twin/reseed.sh                          # prompts for confirmation
#   scripts/twin/reseed.sh --yes                    # skip confirmation
#   scripts/twin/reseed.sh --yes --only=identity    # only the identity category

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

ASSUME_YES=0
SEED_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) SEED_ARGS+=("$arg") ;;
  esac
done

if [ -z "${WALLET_PASSPHRASE:-}" ]; then
  err "WALLET_PASSPHRASE env var is required (the bundle is preserved and decrypted for stage=anchor)."
  exit 1
fi

info "About to:"
info "  1. wipe both TWIN node volumes (deletes engine-state.json + MySQL data)"
info "  2. re-anchor DIDs from the EXISTING wallet bundle (no faucet call)"
info "  3. bring the runtime nodes online"
info "  4. provision per-org tenants + funded wallets (so orgs can mint)"
info "  5. delete data/seed-state.json and run npm run twin:seed${SEED_ARGS:+ -- ${SEED_ARGS[*]}}"

if [ "$ASSUME_YES" -ne 1 ]; then
  warn "This orphans the previously anchored DIDs on IOTA testnet."
  warn "The wallet bundle (data/wallets.enc.json) is preserved."
  printf "%s[twin]%s Type 'yes' to continue: " "$C_YELLOW" "$C_RESET"
  read -r reply
  [ "$reply" = "yes" ] || { info "Aborted."; exit 0; }
fi

info ""
info "── Step 1: reset volumes (wallets preserved) ──"
bash "$(dirname "${BASH_SOURCE[0]}")/reset.sh" --yes || { err "reset failed — aborting"; exit 1; }

info ""
info "── Step 2: re-anchor DIDs (stage=anchor only) ──"
bash "$(dirname "${BASH_SOURCE[0]}")/bootstrap.sh" --stage=anchor || { err "anchor failed — aborting"; exit 1; }

info ""
info "── Step 3: bring runtime nodes online ──"
bash "$(dirname "${BASH_SOURCE[0]}")/up.sh" || { err "node runtime failed to start — aborting"; exit 1; }

info ""
info "── Step 4: provision per-org tenants + funded wallets ──"
node "$ROOT/scripts/twin/wallets.mjs" provision-orgs --force || { err "provision-orgs failed — orgs would be wallet-less and unable to mint"; exit 1; }

info ""
info "── Step 5: seed corridor data ──"
if ! node "$ROOT/scripts/seed-twin-nodes.js" --reset-state "${SEED_ARGS[@]}"; then
  err "seed failed — TWIN nodes are running but data is not fully loaded"
  exit 1
fi

info ""
ok "Reseed complete. Inspect with: ${C_DIM}npm run twin:status${C_RESET}"
