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
      // The migrator needs a real PostgreSQL: covered by the integration tests of the services.
      exclude: ['src/**/*.spec.ts', 'src/index.ts', 'src/postgres.ts'],
      reporter: ['text-summary', 'lcov', 'html'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
