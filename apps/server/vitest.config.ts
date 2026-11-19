import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests share one test database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
