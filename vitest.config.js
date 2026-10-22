import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: true,
    // Unit tests assert the simulated, config-driven behavior and must be
    // hermetic — they must NOT hydrate from a developer's local
    // data/seed-state.json. server/seed.js captures ADAPTER_MODE at module
    // load, so this has to be set here (before import), not in beforeEach.
    // Integration tests build their own DockerAdapter explicitly and gate on
    // TWIN reachability, so they're unaffected.
    env: { ADAPTER_MODE: 'simulated' },
  },
});
