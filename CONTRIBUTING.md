# Contributing

Thank you for helping improve the Trade Corridor Demo. This guide covers how to run the code, how to test a change and what a pull request needs. [AGENTS.md](AGENTS.md) holds the detailed repo map, conventions and gotchas, and it applies to human contributors as much as to coding agents.

## Set up

You need Node.js 24 or newer and npm. Docker with Compose v2 is needed only for docker mode.

```bash
npm ci
ADAPTER_MODE=simulated npm run demo   # Alpha on 4000, Beta on 4001, routing proxy on 4002
```

Simulated mode keeps everything in memory and makes no calls to TWIN nodes or the IOTA testnet, so it is the right mode for most changes. Docker mode runs real TWIN nodes and writes to the IOTA testnet, paid with testnet gas from wallets you create and fund yourself. Its runbook is [docs/running-the-demo.md](docs/running-the-demo.md).

## Commands that spend testnet gas

Run these only when you intend on-chain writes:

- `npm test` and `npm run test:watch`, because they include `tests/integration/`, which writes DIDs, proofs and attestation NFTs whenever a TWIN node answers on `localhost:3000` or `localhost:3001`.
- `npm run twin:bootstrap`, `twin:provision-orgs`, `twin:seed` and `twin:reseed`. `twin:reset` and `twin:reseed` also destroy local node state, and `twin:reset -- --purge-wallets` deletes the wallet bundle.

## Test a change

```bash
npm run build:twin
npx vitest run tests/server
```

The unit suites are hermetic: they run on the simulated adapter and make no network calls. If a run fails with a response the app never sends (`Unauthorized`, `ECONNRESET`), re-run it, or run it with `--no-file-parallelism`, before debugging: it is a known port collision with other local programs ([docs/open-work.md](docs/open-work.md#tests-that-report-less-than-they-appear-to)).

There are no frontend tests. Check UI changes in the browser with two differently themed corridors, for example the default one and `ADAPTER_MODE=simulated CONFIG_FILE=configs/adapt-africa.json npm run demo`, at projector size (1920x1080) and at phone width.

## Conventions

- Server code is plain ESM JavaScript. Only `server/twin/` is TypeScript, compiled by `npm run build:twin`.
- A new Express router goes into `server/routes/`, is mounted in `server/index.js` before `ledger.js`, gets its client call in `client/src/utils/api.js` and is registered in `tests/helpers/setup.js` as well.
- A new TWIN operation goes into the `ITwinAdapter` contract in `server/adapter/base.js` and `ITWIN_ADAPTER_METHODS`, with implementations in both `simulated.js` and `docker.js` and a behaviour test for the simulated one.
- Corridor data comes from the config (`getConfig()` on the server, `useConfig()` in React). Do not hardcode corridor names, colours or labels.
- React code uses functional components with hooks, plain JSX, no router and no component library. Styles live in the single stylesheet `client/src/index.css`, and anything corridor-branded uses its `:root` custom properties.
- Configs contain fictitious data only. Do not add real company names, real people or real registration numbers.

## Documentation

Each topic has one owner document, listed in [docs/README.md](docs/README.md). When you change behaviour, update the owner document in the same pull request, and record in [docs/open-work.md](docs/open-work.md) any defect you find but do not fix.

## Pull requests

- Keep each pull request focused on one change, and use a conventional commit style for its title, for example `fix(server): ...` or `docs: ...`.
- Describe what changed, why, and how you tested it (unit tests, simulated mode, docker mode).
- Never commit `.env`, anything under `data/`, wallet passphrases or the output of `npm run twin:wallets:reveal`.

Read [SECURITY.md](SECURITY.md) before running an instance that other people can reach.
