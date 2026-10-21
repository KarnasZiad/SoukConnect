import { baseConfig, loadConfig } from '@soukconnect/service-kit';
import { z } from 'zod';

export const ordersConfigSchema = z.object({
  ...baseConfig,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4200),
  ORDERS_DATABASE_URL: z.string().startsWith('postgres'),
  RABBITMQ_URL: z.string().startsWith('amqp'),
  /** Public keys of the gateway (JSON array of JWKs). */
  INTERNAL_JWT_PUBLIC_KEYS: z.string().min(2),
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
});

export const loadOrdersConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(ordersConfigSchema, env);
