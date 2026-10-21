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
      // MongoDB and Meilisearch adapters, wiring and CLI: covered by the integration tests.
      exclude: [
        'src/**/*.spec.ts',
        'src/main.ts',
        'src/cli/**',
        'src/mongo/**',
        'src/search/meili-index.ts',
      ],
      reporter: ['text-summary', 'lcov', 'html'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
