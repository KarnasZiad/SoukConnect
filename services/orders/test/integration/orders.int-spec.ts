import { fileURLToPath } from 'node:url';
import { createEnvelope, type Envelope, type MessageType } from '@soukconnect/contracts';
import {
  type Broker,
  connectBroker,
  declareTopology,
  publish,
  startConsumer,
  startRelay,
} from '@soukconnect/messaging';
import { MESSAGING_SCHEMA, postgresOutbox } from '@soukconnect/messaging/postgres';
import { createLogger } from '@soukconnect/service-kit';
import { connectPostgres, migrate } from '@soukconnect/service-kit/postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onPaymentSucceeded, onStockReserved } from '../../src/domain/saga.js';
import { SAGA, sagaHandlers } from '../../src/messaging/saga.js';
import { PostgresOrderStore } from '../../src/postgres/order-store.js';
import type { NewOrder } from '../../src/ports.js';
import { address, buyerId, lines, potId, rugId, shopA, shopB } from '../fixtures.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const logger = createLogger('orders-it', 'silent');

let pg: StartedPostgreSqlContainer;
let rabbit: StartedRabbitMQContainer;
let sql: Sql;
let clock = new Date('2026-10-21T08:00:00Z');
let store: PostgresOrderStore;

beforeAll(async () => {
  [pg, rabbit] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RabbitMQContainer('rabbitmq:4.3-alpine').start(),
  ]);
  sql = connectPostgres(pg.getConnectionUri());
  const shared = [{ id: '0000_messaging', sql: MESSAGING_SCHEMA }];
  expect(await migrate(sql, MIGRATIONS, shared)).toEqual(['0000_messaging', '0001_orders']);
  // Idempotent: a second start applies nothing.
  expect(await migrate(sql, MIGRATIONS, shared)).toEqual([]);
});

afterAll(async () => {
  await sql.end();
  await Promise.all([pg.stop(), rabbit.stop()]);
});

beforeEach(async () => {
  await sql`truncate orders, order_items, order_lines, shipments, outbox, inbox cascade`;
  clock = new Date('2026-10-21T08:00:00Z');
  store = new PostgresOrderStore(sql, undefined, () => clock);
});

function newOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    buyerId,
    idempotencyKey: crypto.randomUUID(),
    requestHash: 'hash-1',
    items: [
      { productId: rugId, quantity: 1 },
      { productId: potId, quantity: 2 },
    ],
    shippingAddress: address,
    ...overrides,
  };
}

async function placed(overrides: Partial<NewOrder> = {}) {
  const result = await store.create(newOrder(overrides));
  if (typeof result === 'string') throw new Error(result);
  return result.order;
}

async function outbox(): Promise<{ type: MessageType; payload: Record<string, unknown> }[]> {
  return sql`select type, payload from outbox order by id`;
}

const reserved = (orderId: string) =>
  createEnvelope(
    'catalog.stock-reserved',
    { orderId, currency: 'MAD', lines },
    { correlationId: orderId },
  );

describe('placing an order', () => {
  it('writes the order and its reservation command in one transaction', async () => {
    const order = await placed();

    expect(order).toMatchObject({ status: 'PENDING', total: null, items: newOrder().items });
    expect(await outbox()).toEqual([
      { type: 'catalog.reserve-stock', payload: { orderId: order.id, items: newOrder().items } },
    ]);
  });

  it('creates one order for concurrent replays of the same request', async () => {
    const input = newOrder();
    const results = await Promise.all([
      store.create(input),
      store.create(input),
      store.create(input),
    ]);

    const ids = new Set(
      results.map((result) => (typeof result === 'string' ? result : result.order.id)),
    );
    expect(ids.size).toBe(1);
    expect(results.filter((result) => typeof result !== 'string' && result.created)).toHaveLength(
      1,
    );
    expect(await store.create({ ...input, requestHash: 'another' })).toBe('key-reused');
  });

  it('refuses a sixth order awaiting payment', async () => {
    for (let index = 0; index < 5; index += 1) await placed();
    expect(await store.create(newOrder())).toBe('too-many-active');
  });
});

describe('running the saga', () => {
  it('awaits the payment at the reserved prices, then confirms', async () => {
    // The real clock: messages are ordered by their UUID v7, which follows the time of creation.
    store = new PostgresOrderStore(sql);
    const order = await placed();
    const message = reserved(order.id);

    const before = Date.now();
    await store.handle(message, (current, now) => onStockReserved(current, message.payload, now));
    await store.handle(message, (current, now) => onStockReserved(current, message.payload, now));

    const awaiting = await store.getForBuyer(buyerId, order.id);
    expect(awaiting).toMatchObject({ status: 'AWAITING_PAYMENT', total: 500_000 });
    const window = (awaiting?.paymentDeadline?.getTime() ?? 0) - before;
    expect(window).toBeGreaterThanOrEqual(15 * 60_000);
    expect(window).toBeLessThan(15 * 60_000 + 5_000);
    expect(awaiting?.lines.map((line) => line.unitPrice)).toEqual([450_000, 25_000]);
    const sent = await outbox();
    expect(sent.map((entry) => entry.type)).toEqual([
      'catalog.reserve-stock',
      'payments.request-payment',
    ]);
    expect(sent[1]?.payload).toMatchObject({ amount: 500_000 });

    const paid = createEnvelope(
      'payments.payment-succeeded',
      { orderId: order.id, paymentId: order.id, amount: 500_000, currency: 'MAD' },
      { correlationId: order.id },
    );
    await store.handle(paid, (current) => onPaymentSucceeded(current, paid.payload));
    const done = await store.getForBuyer(buyerId, order.id);
    expect(done?.status).toBe('CONFIRMED');
    expect(done?.shipments.map((shipment) => shipment.shopId).sort()).toEqual(
      [shopA, shopB].sort(),
    );
    expect((await outbox()).map((entry) => entry.type).slice(2)).toEqual([
      'catalog.commit-stock',
      'orders.order-confirmed',
    ]);
    const [cause] = await sql<{ causation_id: string }[]>`
      select causation_id from outbox where type = 'catalog.commit-stock'`;
    expect(cause?.causation_id).toBe(paid.id);
  });

  it('expires unpaid orders once, even with concurrent sweepers', async () => {
    const orders = await Promise.all([placed(), placed(), placed()]);
    for (const order of orders) {
      const message = reserved(order.id);
      await store.handle(message, (current, now) => onStockReserved(current, message.payload, now));
    }
    clock = new Date('2026-10-21T08:20:00Z');

    const counts = await Promise.all([
      store.expireDue(clock, 2),
      store.expireDue(clock, 2),
      store.expireDue(clock, 2),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(3);
    const types = (await outbox()).map((entry) => entry.type);
    expect(types.filter((type) => type === 'catalog.release-stock')).toHaveLength(3);
    expect(types.filter((type) => type === 'payments.cancel-payment')).toHaveLength(3);
    expect(await store.expireDue(clock, 10)).toBe(0);
  });

  it('ships, delivers and fulfils, and computes the statistics of a shop', async () => {
    const order = await placed();
    const message = reserved(order.id);
    await store.handle(message, (current, now) => onStockReserved(current, message.payload, now));
    const paid = createEnvelope(
      'payments.payment-succeeded',
      { orderId: order.id, paymentId: order.id, amount: 500_000, currency: 'MAD' },
      { correlationId: order.id },
    );
    await store.handle(paid, (current) => onPaymentSucceeded(current, paid.payload));

    expect(await store.updateShipment(shopA, order.id, { status: 'DELIVERED' })).toBe(
      'invalid-transition',
    );
    await store.updateShipment(shopA, order.id, { status: 'SHIPPED', trackingNumber: 'MA1' });
    await store.updateShipment(shopA, order.id, { status: 'DELIVERED' });
    await store.updateShipment(shopB, order.id, { status: 'SHIPPED', trackingNumber: 'MA2' });
    const fulfilled = await store.updateShipment(shopB, order.id, { status: 'DELIVERED' });
    expect(typeof fulfilled !== 'string' && fulfilled.status).toBe('FULFILLED');

    const listing = await store.listForShop(shopB, { page: 1, perPage: 10 });
    expect(listing.items).toEqual([
      expect.objectContaining({
        subtotal: 50_000,
        commission: 4000,
        lines: [expect.objectContaining({ shopId: shopB })],
      }),
    ]);
    expect(await store.statsForShop(shopB, new Date('2026-10-01T00:00:00Z'))).toEqual({
      orders: 1,
      revenue: 50_000,
      commission: 4000,
      net: 46_000,
      averageOrder: 50_000,
      topProducts: [
        { productId: potId, title: { fr: 'Tajine de Safi' }, quantity: 2, revenue: 50_000 },
      ],
    });
  });
});

describe('through RabbitMQ', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await connectBroker({
      url: rabbit.getAmqpUrl(),
      name: 'orders-it',
      logger,
      onLost: (error) => {
        throw error;
      },
    });
  });
  afterAll(async () => {
    await broker.close();
  });

  it('orchestrates a whole order with stand-ins for the catalog and payments', async () => {
    store = new PostgresOrderStore(sql);
    await declareTopology(broker.channel, [
      SAGA,
      { queue: 'stand-in.catalog', bindings: ['catalog.reserve-stock', 'catalog.commit-stock'] },
      { queue: 'stand-in.payments', bindings: ['payments.request-payment'] },
      { queue: 'stand-in.notifications', bindings: ['orders.order-confirmed'] },
    ]);
    const relay = startRelay({
      store: postgresOutbox(sql),
      send: (envelopes) => publish(broker.channel, envelopes),
      logger,
      idleDelayMs: 50,
    });
    const reply = (envelope: Envelope) => publish(broker.channel, [envelope]);
    const confirmed: Envelope[] = [];
    const commits: Envelope[] = [];
    const consumers = await Promise.all([
      startConsumer(broker.channel, { queue: SAGA.queue, handlers: sagaHandlers(store), logger }),
      startConsumer(broker.channel, {
        queue: 'stand-in.catalog',
        logger,
        handlers: {
          'catalog.reserve-stock': (command) =>
            reply(
              createEnvelope(
                'catalog.stock-reserved',
                { orderId: command.payload.orderId, currency: 'MAD', lines },
                { causedBy: command },
              ),
            ),
          'catalog.commit-stock': (command) => {
            commits.push(command);
            return Promise.resolve();
          },
        },
      }),
      startConsumer(broker.channel, {
        queue: 'stand-in.payments',
        logger,
        handlers: {
          'payments.request-payment': (command) =>
            reply(
              createEnvelope(
                'payments.payment-succeeded',
                {
                  orderId: command.payload.orderId,
                  paymentId: crypto.randomUUID(),
                  amount: command.payload.amount,
                  currency: 'MAD',
                },
                { causedBy: command },
              ),
            ),
        },
      }),
      startConsumer(broker.channel, {
        queue: 'stand-in.notifications',
        logger,
        handlers: {
          'orders.order-confirmed': (event) => {
            confirmed.push(event);
            return Promise.resolve();
          },
        },
      }),
    ]);

    const order = await placed();
    relay.notify();

    await vi.waitFor(
      () => {
        expect(confirmed).toHaveLength(1);
        expect(commits).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    // One correlation identifier follows the order through every service.
    expect(confirmed[0]).toMatchObject({ correlationId: order.id, payload: { total: 500_000 } });
    expect((await store.getForBuyer(buyerId, order.id))?.status).toBe('CONFIRMED');

    await Promise.all(consumers.map((consumer) => consumer.stop()));
    await relay.stop();
  });
});
