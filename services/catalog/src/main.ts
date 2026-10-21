import {
  connectBroker,
  declareTopology,
  publish,
  startConsumer,
  startRelay,
} from '@soukconnect/messaging';
import { ensureMessagingIndexes, mongoOutbox } from '@soukconnect/messaging/mongo';
import {
  closeOnSignals,
  createInternalVerifier,
  createLogger,
  parsePublicKeys,
} from '@soukconnect/service-kit';
import { Meilisearch } from 'meilisearch';
import { MongoClient } from 'mongodb';
import { buildApp } from './app.js';
import { loadCatalogConfig } from './config.js';
import { COMMANDS, commandHandlers, INDEXER, indexerHandlers } from './messaging/handlers.js';
import { MongoCatalogStore } from './mongo/catalog-store.js';
import { ensureCatalogIndexes } from './mongo/documents.js';
import { MongoStockLedger } from './mongo/stock-store.js';
import { MeiliSearchIndex } from './search/meili-index.js';

const config = loadCatalogConfig();
const logger = createLogger('catalog', config.LOG_LEVEL);

const mongo = await MongoClient.connect(config.CATALOG_MONGODB_URL);
const db = mongo.db();
await ensureCatalogIndexes(db);
await ensureMessagingIndexes(db);

const meili = new Meilisearch({ host: config.MEILISEARCH_URL, apiKey: config.MEILI_MASTER_KEY });
const index = new MeiliSearchIndex(meili);
await index.configure();

const broker = await connectBroker({ url: config.RABBITMQ_URL, name: 'catalog', logger });
await declareTopology(broker.channel, [COMMANDS, INDEXER]);

const relay = startRelay({
  store: mongoOutbox(db),
  send: (envelopes) => publish(broker.channel, envelopes),
  logger,
});
const store = new MongoCatalogStore(mongo, db, () => {
  relay.notify();
});
const stock = new MongoStockLedger(mongo, db, () => {
  relay.notify();
});
const consumers = [
  await startConsumer(broker.channel, {
    queue: COMMANDS.queue,
    handlers: commandHandlers(stock),
    logger,
  }),
  await startConsumer(broker.channel, {
    queue: INDEXER.queue,
    handlers: indexerHandlers(store, index),
    logger,
  }),
];

const app = await buildApp({
  logger,
  store,
  search: index,
  allowedImageHosts: config.ALLOWED_IMAGE_HOSTS,
  verifyToken: createInternalVerifier({
    audience: 'catalog',
    publicKeys: parsePublicKeys(config.INTERNAL_JWT_PUBLIC_KEYS),
  }),
  health: {
    mongo: () => db.command({ ping: 1 }),
    meilisearch: () => meili.health(),
  },
});
await app.listen({ host: config.HOST, port: config.PORT });

closeOnSignals(logger, async () => {
  await app.close();
  await Promise.all(consumers.map((consumer) => consumer.stop()));
  await relay.stop();
  await broker.close();
  await mongo.close();
});
