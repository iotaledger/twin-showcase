# Security policy

This repository is a demonstration. It runs on the IOTA testnet with synthetic data, and its security is demo-grade by design: every persona password is `demo`, write routes trust the organisation id the browser sends, every GET route is open, and `GET /twin/demo-session`, `/twin/demo-orgs` and `/twin/openapi.json` hand out TWIN node credentials without a login. These shortcuts are documented, not hidden:

- [docs/authentication-architecture.md](docs/authentication-architecture.md) describes the login, the account layers and every secret the demo uses.
- [docs/open-work.md](docs/open-work.md#security) lists the known weaknesses, each with its impact and a next step.
- [docs/deployment.md](docs/deployment.md#before-exposing-an-instance-to-the-internet) lists what to change before an instance is reachable by people who should not control it.

## Using the demo safely

- Use testnet wallets and synthetic data only. Never put mainnet keys, real personal data or real business documents into the demo.
- `npm run demo` listens on all network interfaces. Run it on a trusted network, and do not expose an instance to the internet without the steps in [docs/deployment.md](docs/deployment.md#before-exposing-an-instance-to-the-internet).
- Keep `.env` and everything under `data/` private. Both are gitignored: `data/wallets.enc.json` holds the encrypted wallet mnemonics, and `data/tenant-state.json` and `data/seed-state.json` hold TWIN API keys and passwords in clear text. If a wallet passphrase or mnemonic may have leaked, replace the wallets as described in [docs/wallet-funding-workflow.md](docs/wallet-funding-workflow.md#passphrase-rotation).
