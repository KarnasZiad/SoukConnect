import { baseConfig, loadConfig } from '@soukconnect/service-kit';
import { z } from 'zod';

export const notificationsConfigSchema = z.object({
  ...baseConfig,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4400),
  NOTIFICATIONS_MONGODB_URL: z.string().startsWith('mongodb'),
  REDIS_URL: z.string().startsWith('redis'),
  RABBITMQ_URL: z.string().startsWith('amqp'),
  INTERNAL_JWT_PUBLIC_KEYS: z.string().min(2),
  SMTP_URL: z.string().regex(/^smtps?:\/\//),
  MAIL_FROM: z.string().min(3).default('SoukConnect <commandes@soukconnect.ma>'),
  /** Origin of the front: e-mail links, and the only origin allowed to open a socket. */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
});

export const loadNotificationsConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(notificationsConfigSchema, env);
