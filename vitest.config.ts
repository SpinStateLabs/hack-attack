import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one Postgres database; run files serially.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
