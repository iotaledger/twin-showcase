#!/usr/bin/env bash
# T-314 — Two-stage TWIN bootstrap dispatcher.
#
# Stages:
#   accounts — offline: generate-or-reuse the encrypted wallet bundle and
#              export addresses to data/wallet-addresses.json. No network.
#              Exits with a "send addresses to DevOps" hint when fresh.
#   anchor   — assumes the wallet has been funded by DevOps: decrypts the
#              mnemonic and anchors the node DID / org DID / VMs / admin
#              user / node-identity via TWIN's granular CLI commands. The
#              faucet code path is never entered.
#   both     — default for interactive use: runs `accounts` then, if the
#              wallets are funded, proceeds to `anchor`. Fresh wallets
#              cause it to stop after `accounts` with the same hint.
#
# Usage:
#   scripts/twin/bootstrap.sh                       # both, defaults
#   scripts/twin/bootstrap.sh --stage=accounts      # only accounts
#   scripts/twin/bootstrap.sh --stage=anchor        # only anchor
#   scripts/twin/bootstrap.sh --node=alpha          # only alpha
#   scripts/twin/bootstrap.sh --legacy              # run the old bootstrap-legacy
#                                                    flow (auto-faucet) — see
#                                                    bootstrap-legacy.sh.
#
# Env:
#   WALLET_PASSPHRASE       Required for `anchor` and the auto-progression
#                           from `both` after `accounts`. Required by
#                           wallets.mjs for create/anchor/reveal/rekey.
#   WALLET_BUNDLE_PATH      Optional path override (default data/wallets.enc.json).

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

STAGE=both
NODE=both
LEGACY=0
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --stage=accounts|--stage=anchor|--stage=both) STAGE="${arg#--stage=}" ;;
    --node=alpha|--node=beta|--node=both)         NODE="${arg#--node=}" ;;
    --legacy)                                     LEGACY=1 ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      # Anything else flows through to wallets.mjs (e.g. future flags like
      # --skip-balance-check). Keeps the dispatcher transparent.
      PASSTHROUGH+=("$arg") ;;
  esac
done

if [ "$LEGACY" -eq 1 ]; then
  warn "running the LEGACY bootstrap flow (auto-faucet, bootstrap-legacy container)"
  warn "this calls the IOTA faucet from the executing machine — not recommended for CI."
  exec bash "$(dirname "${BASH_SOURCE[0]}")/bootstrap-legacy.sh" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
fi

# Resolve absolute path to wallets.mjs (works under symlinks too).
WALLETS_MJS="$(dirname "${BASH_SOURCE[0]}")/wallets.mjs"

case "$STAGE" in
  accounts)
    info "── stage=accounts ── generating/reusing wallets for node=$NODE"
    node "$WALLETS_MJS" create --node="$NODE" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
    ;;
  anchor)
    if [ -z "${WALLET_PASSPHRASE:-}" ]; then
      err "WALLET_PASSPHRASE env var is required for stage=anchor"
      exit 1
    fi
    info "── stage=anchor ── anchoring DIDs for node=$NODE"
    node "$WALLETS_MJS" anchor --node="$NODE" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
    ;;
  both)
    info "── stage=accounts ── generating/reusing wallets for node=$NODE"
    node "$WALLETS_MJS" create --node="$NODE" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
    # Only continue to anchor if the operator clearly asked for a full
    # bootstrap AND has a passphrase set (i.e. is the same human/runner
    # that holds the keys). Otherwise stop here so DevOps can fund.
    if [ -z "${WALLET_PASSPHRASE:-}" ]; then
      info ""
      info "${C_DIM}WALLET_PASSPHRASE not set — stopping after accounts.${C_RESET}"
      info "Send data/wallet-addresses.json to DevOps. Once funded, run:"
      info "  ${C_DIM}WALLET_PASSPHRASE=… npm run twin:bootstrap -- --stage=anchor${C_RESET}"
      exit 0
    fi
    info ""
    info "── stage=anchor ── proceeding (WALLET_PASSPHRASE set)"
    info "If the wallet hasn't been funded yet, anchor will fail at the balance pre-check."
    node "$WALLETS_MJS" anchor --node="$NODE" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
    ;;
  *)
    err "internal: unhandled stage=$STAGE"
    exit 1
    ;;
esac

info ""
info "Next: ${C_DIM}npm run twin:up${C_RESET} (start runtime), or ${C_DIM}npm run twin:status${C_RESET}"
