import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Fixtures must be deterministic: no network, no real credentials (brief §12).
    // Any test that tries to hit the network is a bug.
    testTimeout: 20000,
  },
});
