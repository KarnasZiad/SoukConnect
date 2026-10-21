import { createEnvelope, type Envelope, type MessagePayload } from '@soukconnect/contracts';
import {
  type Broker,
  connectBroker,
  declareTopology,
  PermanentError,
  publish,
  startConsumer,
  startRelay,
} from '@soukconnect/messaging';
import { ensureMessagingIndexes, mongoOutbox } from '@soukconnect/messaging/mongo';
import { createLogger } from '@soukconnect/service-kit';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { Meilisearch } from 'meilisearch';
import { type Db, MongoClient } from 'mongodb';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shop } from '../../src/domain/model.js';
import {
  COMMANDS,
  commandHandlers,
  INDEXER,
  indexerHandlers,
} from '../../src/messaging/handlers.js';
import { MongoCatalogStore } from '../../src/mongo/catalog-store.js';
import { ensureCatalogIndexes } from '../../src/mongo/documents.js';
import { MongoStockLedger } from '../../src/mongo/stock-store.js';
import { toSearchDocument } from '../../src/search/documents.js';
import { MeiliSearchIndex } from '../../src/search/meili-index.js';
import { searchQuerySchema } from '../../src/search/query.js';
import { rugInput, sellerId, shopInput } from '../fakes.js';

const MASTER_KEY = 'integration-tests-master-key';
const logger = createLogger('catalog-it', 'silent');

let mongoContainer: StartedMongoDBContainer;
let meiliContainer: StartedTestContainer;
let rabbit: StartedRabbitMQContainer;
let mongo: MongoClient;
let db: Db;
let meili: Meilisearch;
let store: MongoCatalogStore;
let stock: MongoStockLedger;
let shop: Shop;
let databaseIndex = 0;

beforeAll(async () => {
  [mongoContainer, meiliContainer, rabbit] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    new GenericContainer('getmeili/meilisearch:v1.54')
      .withEnvironment({ MEILI_MASTER_KEY: MASTER_KEY, MEILI_NO_ANALYTICS: 'true' })
      .withExposedPorts(7700)
      .withWaitStrategy(Wait.forHttp('/health', 7700))
      .start(),
    new RabbitMQContainer('rabbitmq:4.3-alpine').start(),
  ]);
  mongo = await MongoClient.connect(mongoContainer.getConnectionString(), {
    directConnection: true,
  });
  meili = new Meilisearch({
    host: `http://${meiliContainer.getHost()}:${meiliContainer.getMappedPort(7700)}`,
    apiKey: MASTER_KEY,
  });
});

afterAll(async () => {
  await mongo.close();
  await Promise.all([mongoContainer.stop(), meiliContainer.stop(), rabbit.stop()]);
});

/** A fresh database per test, with an active shop. */
beforeEach(async () => {
  databaseIndex += 1;
  db = mongo.db(`catalog_${databaseIndex}`);
  await ensureCatalogIndexes(db);
  await ensureMessagingIndexes(db);
  store = new MongoCatalogStore(mongo, db);
  stock = new MongoStockLedger(mongo, db);
  const created = await store.createShop(sellerId, shopInput);
  if (created === 'exists') throw new Error('unreachable');
  shop = (await store.setShopStatus(created.id, 'ACTIVE')) ?? created;
});

async function listedRug(stockCount = 2, overrides: Partial<typeof rugInput> = {}) {
  const product = await store.createProduct(shop, { ...rugInput, stock: stockCount, ...overrides });
  const published = await store.setProductStatus(shop, product.id, 'PUBLISHED');
  if (typeof published !== 'object' || published === null) throw new Error('not published');
  return published;
}

const orderId = () => crypto.randomUUID();

function reserveCommand(order: string, items: { productId: string; quantity: number }[]) {
  return createEnvelope(
    'catalog.reserve-stock',
    { orderId: order, items },
    { correlationId: order },
  );
}

async function outboxTypes(): Promise<string[]> {
  return (await db.collection('outbox').find({}).sort({ _id: 1 }).toArray()).map(
    (document) => document.type as string,
  );
}

async function lastOutbox<T extends Envelope['type']>(type: T): Promise<MessagePayload<T>> {
  const document = await db.collection('outbox').find({ type }).sort({ _id: -1 }).limit(1).next();
  if (!document) throw new Error(`No ${type} in the outbox`);
  return document.payload as MessagePayload<T>;
}

async function stockOf(productId: string): Promise<number | undefined> {
  return (
    await db.collection<{ _id: string; stock: number }>('products').findOne({ _id: productId })
  )?.stock;
}

describe('catalog store', () => {
  it('records a product-changed message with every product write', async () => {
    await listedRug();
    expect(await outboxTypes()).toEqual(['catalog.product-changed', 'catalog.product-changed']);
  });

  it('gives a second shop with the same name a suffixed slug', async () => {
    const twin = await store.createShop(crypto.randomUUID(), shopInput);
    expect(twin !== 'exists' && twin.slug).toMatch(/^atelier-fatima-[0-9a-f]{6}$/);
    expect(await store.createShop(sellerId, shopInput)).toBe('exists');
  });

  it('announces every published product when a shop is suspended', async () => {
    await listedRug();
    await listedRug();
    const before = (await outboxTypes()).length;

    await store.setShopStatus(shop.id, 'SUSPENDED');

    expect((await outboxTypes()).length - before).toBe(2);
    expect(await store.getListedProduct((await listedRugSlug()) ?? '')).toBeNull();
  });

  async function listedRugSlug() {
    return (await db.collection<{ slug: string }>('products').findOne({}))?.slug;
  }
});

describe('stock ledger', () => {
  it('reserves all the lines at once, with frozen prices and commission rates', async () => {
    const rug = await listedRug(3);
    const order = orderId();

    await stock.reserve(
      reserveCommand(order, [
        { productId: rug.id, quantity: 1 },
        { productId: rug.id, quantity: 1 },
      ]),
    );

    expect(await stockOf(rug.id)).toBe(1);
    const reserved = await lastOutbox('catalog.stock-reserved');
    expect(reserved).toMatchObject({ orderId: order, currency: 'MAD' });
    expect(reserved.lines).toEqual([
      expect.objectContaining({
        productId: rug.id,
        shopId: shop.id,
        unitPrice: 450_000,
        commissionBps: 1000,
        quantity: 1,
      }),
      expect.objectContaining({ productId: rug.id, quantity: 1 }),
    ]);
  });

  it('rejects the whole order when one product is short, and leaves every stock untouched', async () => {
    const plenty = await listedRug(5);
    const lastOne = await listedRug(1);
    const order = orderId();

    await stock.reserve(
      reserveCommand(order, [
        { productId: plenty.id, quantity: 2 },
        { productId: lastOne.id, quantity: 2 },
      ]),
    );

    expect(await stockOf(plenty.id)).toBe(5);
    expect(await stockOf(lastOne.id)).toBe(1);
    expect(await lastOutbox('catalog.stock-rejected')).toEqual({
      orderId: order,
      unavailable: [{ productId: lastOne.id, requested: 2, available: 1 }],
    });
  });

  it('handles a command delivered twice only once', async () => {
    const rug = await listedRug(2);
    const command = reserveCommand(orderId(), [{ productId: rug.id, quantity: 1 }]);

    await stock.reserve(command);
    await stock.reserve(command);

    expect(await stockOf(rug.id)).toBe(1);
    expect((await outboxTypes()).filter((type) => type === 'catalog.stock-reserved')).toHaveLength(
      1,
    );
  });

  it('sells the last piece to exactly one of two concurrent orders', async () => {
    const rug = await listedRug(1);

    const results = await Promise.allSettled([
      stock.reserve(reserveCommand(orderId(), [{ productId: rug.id, quantity: 1 }])),
      stock.reserve(reserveCommand(orderId(), [{ productId: rug.id, quantity: 1 }])),
    ]);

    // A loser either sees no stock (rejected) or fails on the conflict and will be retried.
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await stockOf(rug.id)).toBe(0);
    const types = await outboxTypes();
    expect(types.filter((type) => type === 'catalog.stock-reserved')).toHaveLength(1);
    // Created, published, then sold out: the search learns that it is out of stock.
    expect(types.filter((type) => type === 'catalog.product-changed')).toHaveLength(3);
  });

  it('gives the stock back on release, once, and counts sales on commit', async () => {
    const rug = await listedRug(2);
    const first = orderId();
    const second = orderId();
    await stock.reserve(reserveCommand(first, [{ productId: rug.id, quantity: 2 }]));
    await stock.reserve(reserveCommand(second, [{ productId: rug.id, quantity: 1 }]));
    expect(await stockOf(rug.id)).toBe(0);

    const release = createEnvelope(
      'catalog.release-stock',
      { orderId: first, reason: 'Payment expired' },
      { correlationId: first },
    );
    await stock.release(release);
    await stock.release(release);
    await stock.release(
      createEnvelope(
        'catalog.release-stock',
        { orderId: first, reason: 'again' },
        { correlationId: first },
      ),
    );
    expect(await stockOf(rug.id)).toBe(2);

    const reserveAgain = reserveCommand(second, [{ productId: rug.id, quantity: 1 }]);
    await expect(stock.reserve(reserveAgain)).rejects.toThrow(PermanentError);

    await stock.commit(
      createEnvelope('catalog.commit-stock', { orderId: second }, { correlationId: second }),
    );
    const sold = await db
      .collection<{ _id: string; sold: number }>('products')
      .findOne({ _id: rug.id });
    expect(sold?.sold).toBe(1);
    await expect(
      stock.release(
        createEnvelope(
          'catalog.release-stock',
          { orderId: second, reason: 'late' },
          { correlationId: second },
        ),
      ),
    ).rejects.toThrow(PermanentError);
    await expect(
      stock.commit(
        createEnvelope('catalog.commit-stock', { orderId: first }, { correlationId: first }),
      ),
    ).rejects.toThrow(PermanentError);
  });
});

describe('search index', () => {
  it('finds products despite typos and accents, with facets and filters', async () => {
    const index = new MeiliSearchIndex(meili, `products_${databaseIndex}`);
    await index.configure();
    const rug = await listedRug(2);
    const pot = await store.createProduct(shop, {
      ...rugInput,
      title: { fr: 'Poterie de Safi émaillée' },
      price: 35_000,
      category: 'pottery',
      attributes: { heightCm: 30, diameterCm: 25, material: 'ceramic', foodSafe: true },
    });
    await index.upsert([
      toSearchDocument(rug, shop),
      toSearchDocument({ ...pot, status: 'PUBLISHED' }, shop),
    ]);

    const search = (query: Record<string, string>) => index.search(searchQuerySchema.parse(query));

    expect((await search({ q: 'tapis beni ouarin' })).hits.map((hit) => hit.id)).toEqual([rug.id]);
    expect((await search({ q: 'potrie' })).hits.map((hit) => hit.id)).toEqual([pot.id]);
    expect((await search({ q: 'zarbia' })).hits.map((hit) => hit.id)).toEqual([rug.id]);
    const all = await search({});
    expect(all.total).toBe(2);
    expect(all.facets.category).toEqual({ rug: 1, pottery: 1 });
    expect((await search({ priceMax: '100000' })).hits.map((hit) => hit.id)).toEqual([pot.id]);
    expect((await search({ sort: 'price-asc' })).hits.map((hit) => hit.id)).toEqual([
      pot.id,
      rug.id,
    ]);

    await index.remove(pot.id);
    expect((await search({})).total).toBe(1);
  });

  it('rebuilds the index from scratch and swaps it in', async () => {
    const index = new MeiliSearchIndex(meili, `products_rebuild_${databaseIndex}`);
    const rug = await listedRug(2);
    await index.configure();
    await index.upsert([
      { ...toSearchDocument(rug, shop), id: crypto.randomUUID(), title_fr: 'Stale' },
    ]);

    async function* documents() {
      for await (const batch of store.listedInBatches(1)) {
        yield batch.map(({ product, shop: owner }) => toSearchDocument(product, owner));
      }
    }
    expect(await index.rebuild(documents())).toBe(1);

    const result = await index.search(searchQuerySchema.parse({}));
    expect(result.hits.map((hit) => hit.id)).toEqual([rug.id]);
  });
});

describe('through RabbitMQ', () => {
  let broker: Broker;

  beforeAll(async () => {
    broker = await connectBroker({
      url: rabbit.getAmqpUrl(),
      name: 'catalog-it',
      logger,
      onLost: (error) => {
        throw error;
      },
    });
  });
  afterAll(async () => {
    await broker.close();
  });

  it('answers a reservation command and keeps the index in step', async () => {
    const index = new MeiliSearchIndex(meili, `products_e2e_${databaseIndex}`);
    await index.configure();
    const rug = await listedRug(1);
    await declareTopology(broker.channel, [
      COMMANDS,
      INDEXER,
      { queue: 'test.saga', bindings: ['catalog.stock-reserved', 'catalog.stock-rejected'] },
    ]);
    const relay = startRelay({
      store: mongoOutbox(db),
      send: (envelopes) => publish(broker.channel, envelopes),
      logger,
      idleDelayMs: 50,
    });
    const answers: Envelope[] = [];
    const consumers = await Promise.all([
      startConsumer(broker.channel, {
        queue: COMMANDS.queue,
        handlers: commandHandlers(stock),
        logger,
      }),
      startConsumer(broker.channel, {
        queue: INDEXER.queue,
        handlers: indexerHandlers(store, index),
        logger,
      }),
      startConsumer(broker.channel, {
        queue: 'test.saga',
        logger,
        handlers: {
          'catalog.stock-reserved': (envelope) => {
            answers.push(envelope);
            return Promise.resolve();
          },
        },
      }),
    ]);

    const order = orderId();
    const command = reserveCommand(order, [{ productId: rug.id, quantity: 1 }]);
    await publish(broker.channel, [command]);

    await vi.waitFor(
      () => {
        expect(answers).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    expect(answers[0]).toMatchObject({ correlationId: order, causationId: command.id });
    // Sold out after the reservation: the indexer marks it out of stock.
    await vi.waitFor(
      async () => {
        const result = await index.search(searchQuerySchema.parse({ inStock: 'false' }));
        expect(result.hits.map((hit) => hit.id)).toEqual([rug.id]);
      },
      { timeout: 15_000 },
    );

    await Promise.all(consumers.map((consumer) => consumer.stop()));
    await relay.stop();
  });
});
