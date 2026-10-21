import { baseConfig, loadConfig } from '@soukconnect/service-kit';
import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const gatewayConfigSchema = z.object({
  ...baseConfig,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  /** Origin of the front: state-changing requests must come from it (CSRF). */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  GATEWAY_DATABASE_URL: z.string().startsWith('postgres'),
  REDIS_URL: z.string().startsWith('redis'),
  /** Private key signing the internal tokens (JWK with its kid). */
  INTERNAL_JWT_PRIVATE_KEY: z.string().min(2),
  CATALOG_URL: z.url().default('http://localhost:4100'),
  ORDERS_URL: z.url().default('http://localhost:4200'),
  PAYMENTS_URL: z.url().default('http://localhost:4300'),
  NOTIFICATIONS_URL: z.url().default('http://localhost:4400'),
  /** Behind the Ingress in production: one trusted hop gives the visitor's address. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  COOKIE_SECURE: flag.default(true),
  SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export const loadGatewayConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(gatewayConfigSchema, env);
