import { baseConfig, loadConfig } from '@soukconnect/service-kit';
import { z } from 'zod';

export const paymentsConfigSchema = z.object({
  ...baseConfig,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4300),
  PAYMENTS_DATABASE_URL: z.string().startsWith('postgres'),
  RABBITMQ_URL: z.string().startsWith('amqp'),
  INTERNAL_JWT_PUBLIC_KEYS: z.string().min(2),
  /** Test mode only: a live key would charge real cards (SECURITY.md). */
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(sk|rk)_test_[A-Za-z0-9]+$/, 'A Stripe test-mode key is required'),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/),
});

export const loadPaymentsConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(paymentsConfigSchema, env);
