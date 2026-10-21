import { fileURLToPath } from 'node:url';
import {
  connectBroker,
  declareTopology,
  publish,
  startConsumer,
  startRelay,
} from '@soukconnect/messaging';
import { MESSAGING_SCHEMA, postgresOutbox } from '@soukconnect/messaging/postgres';
import {
  closeOnSignals,
  createInternalVerifier,
  createLogger,
  parsePublicKeys,
} from '@soukconnect/service-kit';
import { connectPostgres, migrate } from '@soukconnect/service-kit/postgres';
import Stripe from 'stripe';
import { buildApp } from './app.js';
import { loadPaymentsConfig } from './config.js';
import { COMMANDS, commandHandlers } from './messaging/commands.js';
import { PostgresPaymentStore } from './postgres/payment-store.js';
import { StripeGateway } from './stripe/stripe-gateway.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

const config = loadPaymentsConfig();
const logger = createLogger('payments', config.LOG_LEVEL);

const sql = connectPostgres(config.PAYMENTS_DATABASE_URL);
const applied = await migrate(sql, MIGRATIONS, [{ id: '0000_messaging', sql: MESSAGING_SCHEMA }]);
if (applied.length > 0) logger.info({ applied }, 'migrations applied');

const gateway = new StripeGateway(
  new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10_000 }),
  config.STRIPE_WEBHOOK_SECRET,
);

const broker = await connectBroker({ url: config.RABBITMQ_URL, name: 'payments', logger });
await declareTopology(broker.channel, [COMMANDS]);
const relay = startRelay({
  store: postgresOutbox(sql),
  send: (envelopes) => publish(broker.channel, envelopes),
  logger,
});
const store = new PostgresPaymentStore(sql, () => {
  relay.notify();
});
const consumer = await startConsumer(broker.channel, {
  queue: COMMANDS.queue,
  handlers: commandHandlers(store, gateway),
  logger,
});

const app = await buildApp({
  logger,
  store,
  gateway,
  verifyToken: createInternalVerifier({
    audience: 'payments',
    publicKeys: parsePublicKeys(config.INTERNAL_JWT_PUBLIC_KEYS),
  }),
  health: { postgres: () => sql`select 1` },
});
await app.listen({ host: config.HOST, port: config.PORT });

closeOnSignals(logger, async () => {
  await app.close();
  await consumer.stop();
  await relay.stop();
  await broker.close();
  await sql.end();
});
