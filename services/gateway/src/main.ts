import { fileURLToPath } from 'node:url';
import { closeOnSignals, createLogger, importSigningKey } from '@soukconnect/service-kit';
import { connectPostgres, migrate } from '@soukconnect/service-kit/postgres';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { PostgresAccountStore } from './auth/accounts.js';
import { RedisLoginGuard } from './auth/login-guard.js';
import { RedisSessionStore } from './auth/sessions.js';
import { RedisCartStore } from './cart/cart-store.js';
import { loadGatewayConfig } from './config.js';
import { type OpenApiDocument, OpenApiAggregator } from './docs/openapi.js';
import { cookieNames } from './http/context.js';
import { FetchInternalClient } from './proxy/internal-client.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

const config = loadGatewayConfig();
const logger = createLogger('gateway', config.LOG_LEVEL);

const sql = connectPostgres(config.GATEWAY_DATABASE_URL);
const applied = await migrate(sql, MIGRATIONS);
if (applied.length > 0) logger.info({ applied }, 'migrations applied');
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
const signingKey = await importSigningKey(config.INTERNAL_JWT_PRIVATE_KEY);
const upstreams = {
  catalog: config.CATALOG_URL,
  orders: config.ORDERS_URL,
  payments: config.PAYMENTS_URL,
  notifications: config.NOTIFICATIONS_URL,
};

let ownDocument: () => OpenApiDocument = () => ({
  openapi: '3.1.0',
  info: { title: 'gateway', version: '0.1.0' },
  paths: {},
});
const docs = new OpenApiAggregator(
  () => ownDocument(),
  async (upstream) => {
    const response = await fetch(`${upstreams[upstream]}/openapi.json`, {
      signal: AbortSignal.timeout(3000),
    });
    return (await response.json()) as OpenApiDocument;
  },
  cookieNames(config.COOKIE_SECURE).session,
);

const app = await buildApp({
  logger,
  accounts: new PostgresAccountStore(sql),
  sessions: new RedisSessionStore(redis, config.SESSION_DAYS * 86_400),
  guard: new RedisLoginGuard(redis),
  carts: new RedisCartStore(redis),
  internal: new FetchInternalClient(signingKey, upstreams),
  signingKey,
  upstreams,
  publicOrigin: new URL(config.PUBLIC_URL).origin,
  cookieSecure: config.COOKIE_SECURE,
  sessionDays: config.SESSION_DAYS,
  trustProxyHops: config.TRUST_PROXY_HOPS,
  redis,
  docs,
  health: { postgres: () => sql`select 1`, redis: () => redis.ping() },
});
await app.ready();
ownDocument = () => app.swagger() as unknown as OpenApiDocument;
// The services may start after the gateway: the document is refreshed every ten minutes.
void docs.refresh().catch((error: unknown) => {
  logger.warn({ err: error }, 'OpenAPI aggregation failed');
});
setInterval(() => void docs.refresh().catch(() => undefined), 10 * 60_000).unref();
await app.listen({ host: config.HOST, port: config.PORT });

closeOnSignals(logger, async () => {
  await app.close();
  redis.disconnect();
  await sql.end();
});
