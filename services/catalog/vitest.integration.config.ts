import { defineConfig } from 'vitest/config';

// Real MongoDB (replica set), Meilisearch and RabbitMQ started by Testcontainers (Docker required).
export default defineConfig({
  resolve: { conditions: ['@soukconnect/source'] },
  ssr: { resolve: { conditions: ['@soukconnect/source'] } },
  test: {
    include: ['test/integration/**/*.int-spec.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
