import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@soukconnect/source'] },
  ssr: { resolve: { conditions: ['@soukconnect/source'] } },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Database and broker adapters: covered by the integration tests on real containers.
      exclude: [
        'src/**/*.spec.ts',
        'src/index.ts',
        'src/postgres.ts',
        'src/mongo.ts',
        'src/connection.ts',
      ],
      reporter: ['text-summary', 'lcov', 'html'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
