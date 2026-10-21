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
import { buildApp } from './app.js';
import { loadOrdersConfig } from './config.js';
import { SAGA, sagaHandlers } from './messaging/saga.js';
import { startSweeper } from './messaging/sweeper.js';
import { PostgresOrderStore } from './postgres/order-store.js';

/** migrations/ sits next to src/ and dist/, in the repository and in the image alike. */
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

const config = loadOrdersConfig();
const logger = createLogger('orders', config.LOG_LEVEL);

const sql = connectPostgres(config.ORDERS_DATABASE_URL);
const applied = await migrate(sql, MIGRATIONS, [{ id: '0000_messaging', sql: MESSAGING_SCHEMA }]);
if (applied.length > 0) logger.info({ applied }, 'migrations applied');

const broker = await connectBroker({ url: config.RABBITMQ_URL, name: 'orders', logger });
await declareTopology(broker.channel, [SAGA]);

const relay = startRelay({
  store: postgresOutbox(sql),
  send: (envelopes) => publish(broker.channel, envelopes),
  logger,
});
const store = new PostgresOrderStore(sql, () => {
  relay.notify();
});
const consumer = await startConsumer(broker.channel, {
  queue: SAGA.queue,
  handlers: sagaHandlers(store),
  logger,
});
const sweeper = startSweeper({ store, logger, intervalMs: config.EXPIRY_SWEEP_INTERVAL_MS });

const app = await buildApp({
  logger,
  store,
  verifyToken: createInternalVerifier({
    audience: 'orders',
    publicKeys: parsePublicKeys(config.INTERNAL_JWT_PUBLIC_KEYS),
  }),
  health: { postgres: () => sql`select 1` },
});
await app.listen({ host: config.HOST, port: config.PORT });

closeOnSignals(logger, async () => {
  await app.close();
  await sweeper.stop();
  await consumer.stop();
  await relay.stop();
  await broker.close();
  await sql.end();
});
