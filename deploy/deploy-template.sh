#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# HOST DEPLOY SCRIPT — TEMPLATE.
# This repo file is `deploy/deploy-template.sh`; DevOps installs a copy of it at
# `/home/deployer/deploy.sh` on the deploy host (docs/ci-deployment.md → "Host
# one-time setup"). It is the FIXED command the `deployer` SSH user is pinned to
# (forced command in authorized_keys). The GitHub workflow can ONLY trigger this;
# it cannot run anything else. The client's command line arrives in
# $SSH_ORIGINAL_COMMAND. Edit the per-corridor config block below, then
# re-install on the host.
#
# MODEL: fresh corridor on every deploy (Option B).
#   • node wallets are PRESERVED (twin:reseed reuses data/wallets.enc.json —
#     no faucet, no re-funding); only DIDs / per-org tenants / org wallets
#     regenerate, and provision-orgs spends a little IOTA from the node wallet.
#   • twin:reseed also re-provisions each node's x-enc-tenant-token (the DSP
#     data-plane gate) into data/tenant-state.json, so the encrypted token always
#     matches the freshly regenerated tenant (see docs/dsp-design.md).
#   • WALLET_PASSPHRASE comes from the GitHub secret, passed as the 3rd token
#     (env-only, not argv). Falls back to a server-side SECRETS_FILE if absent.
#
# Invoked as:   deploy.sh <corridor> <image-ref> <repo-ref> [wallet-passphrase]
#   <corridor>          switch-case selector below (e.g. vietnam-us)
#   <image-ref>         webapp image, e.g. ghcr.io/<owner>/<repo>:<sha>
#   <repo-ref>          git ref to check out (commit sha or branch) — passed by
#                       the action (github.sha). Falls back to REPO_BRANCH below.
#   [wallet-passphrase] optional; MUST NOT contain whitespace
#
# Host prerequisites (one-off, per corridor):
#   • repo checked out at REPO_DIR (set below), Node 24 + npm, Docker compose v2.
#   • data/wallets.enc.json committed with FUNDED node-wallet addresses on the
#     IOTA testnet (anchor hard-fails otherwise).
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Parse args (positional, or from the forced-command original command) ──────
if [ "$#" -ge 2 ]; then
  CORRIDOR="$1"; IMAGE_REF="$2"; REPO_REF_ARG="${3:-}"; PASSPHRASE_ARG="${4:-}"
elif [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # shellcheck disable=SC2086
  set -- $SSH_ORIGINAL_COMMAND
  CORRIDOR="${1:-}"; IMAGE_REF="${2:-}"; REPO_REF_ARG="${3:-}"; PASSPHRASE_ARG="${4:-}"
else
  echo "usage: deploy.sh <corridor> <image-ref> <repo-ref> [wallet-passphrase]" >&2; exit 2
fi
[ -n "$CORRIDOR" ]  || { echo "ERROR: missing <corridor>"  >&2; exit 2; }
[ -n "$IMAGE_REF" ] || { echo "ERROR: missing <image-ref>" >&2; exit 2; }

# ── Per-corridor configuration — EDIT these paths for your host ───────────────
case "$CORRIDOR" in
  vietnam-us)
    REPO_URL="git@github.com:iotaledger/twin-showcase.git"
    REPO_DIR="/opt/vietnam-us"
    REPO_BRANCH="main"
    CONFIG_FILE="configs/vietnam-us.json"
    # Used ONLY if no passphrase was passed from CI. `set -a; . FILE` style.
    SECRETS_FILE="/home/deployer/corridors/vietnam-us.secrets.env"
    ;;
  # kenya-eu)
  #   REPO_URL="git@github.com:iotaledger/twin-showcase.git"
  #   REPO_DIR="/opt/kenya-eu"
  #   REPO_BRANCH="main"
  #   CONFIG_FILE="configs/kenya-eu.json"
  #   SECRETS_FILE="/home/deployer/corridors/kenya-eu.secrets.env"
  #   ;;
  *)
    echo "ERROR: unknown corridor '$CORRIDOR' — add a case branch in deploy.sh" >&2
    exit 2
    ;;
esac

PROJECT="${CORRIDOR}-webapp"
REPO_REF="${REPO_REF_ARG:-$REPO_BRANCH}"   # CI passes github.sha; else branch default

# ── Logging: tee everything to a timestamped host log; on failure point to it ─
LOG_DIR="/home/deployer/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-${CORRIDOR}-$(date +%Y%m%d-%H%M%S).log"
# Never echo the passphrase below; nothing here writes it to the log.
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "[$CORRIDOR][ERROR] deploy FAILED (rc=$rc) — full log: $LOG_FILE"; fi' EXIT

echo "[$CORRIDOR] === deploy start $(date -u +%FT%TZ) ==="
echo "[$CORRIDOR] image=$IMAGE_REF dir=$REPO_DIR log=$LOG_FILE"

# ── Resolve WALLET_PASSPHRASE: CI arg first, else server-side secrets file ────
if [ -n "$PASSPHRASE_ARG" ]; then
  WALLET_PASSPHRASE="$PASSPHRASE_ARG"
  echo "[$CORRIDOR] WALLET_PASSPHRASE: from CI (github secret)"
elif [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$SECRETS_FILE"; set +a
  echo "[$CORRIDOR] WALLET_PASSPHRASE: from $SECRETS_FILE"
fi
[ -n "${WALLET_PASSPHRASE:-}" ] || {
  echo "[$CORRIDOR][ERROR] no WALLET_PASSPHRASE (not passed from CI, no $SECRETS_FILE)" >&2; exit 1; }

# ── 1. Ensure the repo checkout exists, then sync it to the deployed commit ───
# Self-bootstrapping: clone on first run, otherwise update. The host only needs
# git + read credentials for the `deployer` user (deploy key or cached token);
# no manual `git clone` step. The parent of REPO_DIR must be writable by
# `deployer` (or REPO_DIR pre-created and chown'd) so the clone can land.
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -e "$REPO_DIR" ] && [ -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]; then
    echo "[$CORRIDOR][ERROR] $REPO_DIR exists but is not a git checkout — move it aside first (e.g. mv $REPO_DIR ${REPO_DIR}.old)" >&2
    exit 1
  fi
  echo "[$CORRIDOR] cloning $REPO_URL → $REPO_DIR…"
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR" || { echo "ERROR: $REPO_DIR not found" >&2; exit 1; }

export CONFIG_FILE ADAPTER_MODE=docker WALLET_PASSPHRASE

# Sync the checkout to the ref the action passed (github.sha keeps host scripts
# ↔ deployed image in lockstep). Works for both a commit sha (detached) and a
# branch name; for a branch we also fast-forward to its remote tip.
echo "[$CORRIDOR] updating checkout to $REPO_REF + deps…"
git fetch --quiet origin
git checkout --quiet --force "$REPO_REF"
if git show-ref --verify --quiet "refs/remotes/origin/$REPO_REF"; then
  git merge --ff-only --quiet "origin/$REPO_REF" || true
fi
npm ci
# Compile the TypeScript TWIN REST wrappers (server/twin/dist/) — gitignored
# build output that the seed/adapter step imports at runtime. `npm ci` alone
# does not produce it, so build it explicitly on the fresh checkout.
npm run build:twin

# ── 2. Clean slate for THIS corridor's stacks ────────────────────────────────
# Scoped teardown of ONLY the two corridor compose projects (TWIN nodes + the
# webapp), so we always start fresh. Deliberately NOT a host-wide `docker rm -f
# $(docker ps -aq)` / volume prune — this runs on every deploy and the host may
# carry other workloads/environments that must not be touched. `twin:reseed`
# resets the nodes too, but this also clears the webapp project and any orphans.
echo "[$CORRIDOR] tearing down previous $CORRIDOR stacks (scoped)…"
docker compose -f docker-compose.twin.yml down -v --remove-orphans 2>/dev/null || true
docker compose -f docker-compose.deploy.yml -p "$PROJECT" down -v --remove-orphans 2>/dev/null || true

# ── 3. Fresh rebuild of the two TWIN nodes (node wallets preserved) ───────────
echo "[$CORRIDOR] reseeding the two TWIN nodes…"
npm run twin:reseed -- --yes
npm run twin:status

# ── 4. Roll the webapp to the new image against the freshly-seeded nodes ──────
echo "[$CORRIDOR] rolling the webapp to $IMAGE_REF…"
WEBAPP_IMAGE="$IMAGE_REF" CONFIG_FILE="$CONFIG_FILE" COMPOSE_PROJECT_NAME="$PROJECT" \
  docker compose -f docker-compose.deploy.yml -p "$PROJECT" up -d --pull always --force-recreate --remove-orphans

echo "[$CORRIDOR] === deploy complete $(date -u +%FT%TZ) ==="
