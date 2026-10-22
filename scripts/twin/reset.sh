#!/usr/bin/env bash
# Wipe TWIN stack state (containers + MySQL + engine-state volumes).
#
# Default behaviour PRESERVES the encrypted wallet bundle
# (data/wallets.enc.json + data/wallet-addresses.json) so the next
# `twin:bootstrap --stage=anchor` can re-anchor DIDs without DevOps
# re-funding the wallets.
#
# Usage:
#   scripts/twin/reset.sh                       # prompts for confirmation
#   scripts/twin/reset.sh --yes                 # skip confirmation (CI)
#   scripts/twin/reset.sh --bootstrap           # also re-bootstrap immediately
#   scripts/twin/reset.sh --purge-wallets       # ALSO wipe the wallet bundle
#                                                 (forces re-funding next time)
#
# Note (T-314): the per-node MySQL containers are compose-managed
# (created by `wallets.mjs anchor` via `docker compose up -d --wait
# db-<node>`). The explicit container/volume cleanup below covers
# residuals from prior buggy runs (e.g. db containers that ended up
# detached from the compose project due to Docker Desktop daemon
# issues) — `docker compose down -v` alone is the primary cleanup.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

ASSUME_YES=0
RUN_BOOTSTRAP=0
PURGE_WALLETS=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)         ASSUME_YES=1 ;;
    --bootstrap)      RUN_BOOTSTRAP=1 ;;
    --purge-wallets)  PURGE_WALLETS=1 ;;
    -h|--help)
      sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

if [ "$ASSUME_YES" -ne 1 ]; then
  warn "This will DELETE all MySQL data, engine-state, and the previously anchored DIDs."
  if [ "$PURGE_WALLETS" -eq 1 ]; then
    warn "ALSO --purge-wallets: the encrypted wallet bundle will be wiped. DevOps will need to re-fund."
  else
    info "The encrypted wallet bundle is PRESERVED (data/wallets.enc.json kept)."
  fi
  printf "%s[twin]%s Type 'yes' to continue: " "$C_YELLOW" "$C_RESET"
  read -r reply
  [ "$reply" = "yes" ] || { info "Aborted."; exit 0; }
fi

# 1. Remove any container whose name starts with "twin-showcase-" — this
#    catches both compose-managed services (twin-bootstrap-*, twin-node-*)
#    and any docker-run-created residuals from earlier flow iterations.
#    Compatible with bash 3.2 (macOS default — no `mapfile`).
info "Removing twin-showcase containers..."
container_ids="$(docker ps -aq --filter "name=^twin-showcase-" 2>/dev/null || true)"
if [ -n "$container_ids" ]; then
  count=$(printf '%s\n' "$container_ids" | wc -l | tr -d ' ')
  printf '%s\n' "$container_ids" | xargs docker rm -f >/dev/null 2>&1 || true
  ok "Removed $count container(s)."
else
  info "No containers to remove."
fi

# 2. Best-effort: `docker compose down -v` for anything we missed (also
#    removes the project's networks). Quiet on errors — typical case is
#    that step 1 already removed everything.
"${DC[@]}" down -v >/dev/null 2>&1 || true

# 3. Volumes — `docker compose down -v` only wipes volumes attached to
#    compose-managed containers, so wipe explicitly by name. This is
#    idempotent: missing volumes raise an ignored error.
info "Removing twin-showcase volumes..."
declare -i removed=0
for vol in twin-showcase_mysql_data_alpha twin-showcase_mysql_data_beta \
           twin-showcase_twin_data_alpha twin-showcase_twin_data_beta; do
  if docker volume rm "$vol" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done
ok "Removed $removed volume(s)."

# 4. Network — created on-demand by wallets.mjs anchor too, so wipe it.
docker network rm twin-showcase_default >/dev/null 2>&1 || true

# 5. On-disk state that references the wiped node DB (T-4V03). Both files
#    point at tenants/users/AIG vertices that no longer exist after the
#    MySQL wipe; keeping them makes follow-up tooling silently reuse dead
#    references:
#      - tenant-state.json: node tenant api-key (recreated by the next
#        `bootstrap --stage=anchor`) AND per-org tenants+credentials —
#        if stale, `provision-orgs` SKIPS the orgs and the seed's
#        org-signed attestations fail with "Kitsune login failed (401)".
#      - seed-state.json: TWIN resource ids from previous seeds.
#    The wallet bundle is NOT touched here (see --purge-wallets below).
info "Removing stale state files (tenant-state.json, seed-state.json)..."
rm -f "$ROOT/data/tenant-state.json" "$ROOT/data/seed-state.json"

ok "Stack reset."

if [ "$PURGE_WALLETS" -eq 1 ]; then
  rm -f "$ROOT/data/wallets.enc.json" "$ROOT/data/wallet-addresses.json" "$ROOT/data/.wallets.lock"
  ok "Wallet bundle purged. Next bootstrap will generate fresh addresses requiring re-funding."
else
  info "Wallet bundle preserved at data/wallets.enc.json — next anchor reuses the funded wallet."
fi

if [ "$RUN_BOOTSTRAP" -eq 1 ]; then
  info "Re-running bootstrap..."
  exec "$(dirname "${BASH_SOURCE[0]}")/bootstrap.sh"
fi

info "Next: ${C_DIM}npm run twin:bootstrap${C_RESET} (or ${C_DIM}--stage=anchor${C_RESET} if wallets preserved + funded)."
