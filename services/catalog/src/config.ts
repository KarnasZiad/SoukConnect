import { baseConfig, loadConfig } from '@soukconnect/service-kit';
import { z } from 'zod';

const list = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1));

export const catalogConfigSchema = z.object({
  ...baseConfig,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  CATALOG_MONGODB_URL: z.string().startsWith('mongodb'),
  MEILISEARCH_URL: z.url(),
  MEILI_MASTER_KEY: z.string().min(16),
  RABBITMQ_URL: z.string().startsWith('amqp'),
  /** Public keys of the gateway (JSON array of JWKs). */
  INTERNAL_JWT_PUBLIC_KEYS: z.string().min(2),
  /** Hosts of the image CDN, comma-separated. */
  ALLOWED_IMAGE_HOSTS: list.default(['images.soukconnect.ma']),
});
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;

export const loadCatalogConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(catalogConfigSchema, env);
