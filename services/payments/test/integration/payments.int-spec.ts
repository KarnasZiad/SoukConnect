import { fileURLToPath } from 'node:url';
import type { Envelope } from '@soukconnect/contracts';
import {
  type Broker,
  connectBroker,
  declareTopology,
  publish,
  startConsumer,
  startRelay,
} from '@soukconnect/messaging';
import { MESSAGING_SCHEMA, postgresOutbox } from '@soukconnect/messaging/postgres';
import {
  createInternalVerifier,
  createLogger,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
  signInternalToken,
} from '@soukconnect/service-kit';
import { connectPostgres, migrate } from '@soukconnect/service-kit/postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { COMMANDS, commandHandlers } from '../../src/messaging/commands.js';
import { PostgresPaymentStore } from '../../src/postgres/payment-store.js';
import { FakeGateway, requestPayment, shopA, shopB, signedEvent } from '../fakes.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const logger = createLogger('payments-it', 'silent');
const context = { attempt: 0, redelivered: false };

let pg: StartedPostgreSqlContainer;
let rabbit: StartedRabbitMQContainer;
let sql: Sql;
let store: PostgresPaymentStore;
let gateway: FakeGateway;

beforeAll(async () => {
  [pg, rabbit] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RabbitMQContainer('rabbitmq:4.3-alpine').start(),
  ]);
  sql = connectPostgres(pg.getConnectionUri());
  expect(await migrate(sql, MIGRATIONS, [{ id: '0000_messaging', sql: MESSAGING_SCHEMA }])).toEqual(
    ['0000_messaging', '0001_payments'],
  );
});

afterAll(async () => {
  await sql.end();
  await Promise.all([pg.stop(), rabbit.stop()]);
});

beforeEach(async () => {
  await sql`truncate ledger_entries, payments, stripe_events, outbox, inbox cascade`;
  store = new PostgresPaymentStore(sql);
  gateway = new FakeGateway();
});

async function requested() {
  const command = requestPayment();
  await commandHandlers(store, gateway)['payments.request-payment']?.(command, context);
  const payment = await store.findByOrder(command.payload.orderId);
  if (!payment) throw new Error('no payment');
  return { command, payment };
}

const succeeded = (intentId: string, id?: string) => ({
  id: id ?? `evt_${crypto.randomUUID()}`,
  type: 'payment_intent.succeeded',
  intentId,
  failureMessage: null,
});

describe('payments in PostgreSQL', () => {
  it('records one payment per order, whatever the number of deliveries', async () => {
    const { command, payment } = await requested();
    const handlers = commandHandlers(store, gateway);
    await handlers['payments.request-payment']?.(command, context);

    expect(payment).toMatchObject({
      status: 'REQUIRES_PAYMENT',
      amount: 500_000,
      shares: command.payload.shares,
    });
    expect((await sql`select * from payments`).length).toBe(1);
    expect(gateway.intents.size).toBe(1);
  });

  it('books the sale, the commission and the event together, once', async () => {
    const { payment } = await requested();
    const event = succeeded(payment.intentId);
    const checked = { amountReceived: 500_000, currency: 'mad' };

    const outcomes = await Promise.all([
      store.applyEvent(event, checked),
      store.applyEvent(event, checked),
      store.applyEvent(event, checked),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(2);
    const entries = await sql<{ shop_id: string; kind: string; amount: number }[]>`
      select shop_id, kind, amount from ledger_entries order by shop_id, kind desc`;
    expect(entries).toEqual([
      { shop_id: shopA, kind: 'SALE', amount: 450_000 },
      { shop_id: shopA, kind: 'COMMISSION', amount: -45_000 },
      { shop_id: shopB, kind: 'SALE', amount: 50_000 },
      { shop_id: shopB, kind: 'COMMISSION', amount: -4000 },
    ]);
    expect(await sql`select type, payload from outbox`).toEqual([
      {
        type: 'payments.payment-succeeded',
        payload: {
          orderId: payment.orderId,
          paymentId: payment.id,
          amount: 500_000,
          currency: 'MAD',
        },
      },
    ]);
  });

  it('keeps the ledger append-only, and balances it to zero after a refund', async () => {
    const { payment } = await requested();
    await store.applyEvent(succeeded(payment.intentId), {
      amountReceived: 500_000,
      currency: 'mad',
    });
    await store.applyEvent(
      {
        id: 'evt_refund',
        type: 'charge.refunded',
        intentId: payment.intentId,
        failureMessage: null,
      },
      null,
    );

    const [total] = await sql<
      { total: number }[]
    >`select sum(amount)::bigint as total from ledger_entries`;
    expect(total?.total).toBe(0);
    expect(await store.balanceOf(shopA, new Date(Date.now() - 60_000))).toEqual({
      sales: 450_000,
      commission: 0,
      refunds: 450_000,
      net: 0,
    });
    await expect(sql`update ledger_entries set amount = 0`).rejects.toThrow(/append-only/);
    await expect(sql`delete from ledger_entries`).rejects.toThrow(/append-only/);
  });
});

describe('the webhook endpoint on a real database', () => {
  it('confirms a payment from a signed Stripe event and ignores its replay', async () => {
    const { payment } = await requested();
    const { privateJwk, publicJwk } = await generateSigningKeys('it');
    const key = await importSigningKey(JSON.stringify(privateJwk));
    const app = await buildApp({
      logger,
      store,
      gateway,
      verifyToken: createInternalVerifier({
        audience: 'payments',
        publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
      }),
    });
    const headers = {
      authorization: `Bearer ${await signInternalToken(key, 'payments', { userId: null, role: 'visitor', shopId: null })}`,
      'content-type': 'application/json',
    };
    gateway.pay(payment.intentId);
    const event = signedEvent('payment_intent.succeeded', {
      object: 'payment_intent',
      id: payment.intentId,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { ...headers, 'stripe-signature': event.signature },
      payload: event.payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { ...headers, 'stripe-signature': event.signature },
      payload: event.payload,
    });

    expect(first.json()).toMatchObject({ outcome: 'applied' });
    expect(replay.json()).toMatchObject({ outcome: 'duplicate' });
    expect((await store.findByOrder(payment.orderId))?.status).toBe('SUCCEEDED');
    await app.close();
  });
});

describe('through RabbitMQ', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await connectBroker({
      url: rabbit.getAmqpUrl(),
      name: 'payments-it',
      logger,
      onLost: (error) => {
        throw error;
      },
    });
  });
  afterAll(async () => {
    await broker.close();
  });

  it('answers a payment request, then tells orders once Stripe confirms', async () => {
    await declareTopology(broker.channel, [
      COMMANDS,
      { queue: 'stand-in.orders', bindings: ['payments.payment-succeeded'] },
    ]);
    const relay = startRelay({
      store: postgresOutbox(sql),
      send: (envelopes) => publish(broker.channel, envelopes),
      logger,
      idleDelayMs: 50,
    });
    store = new PostgresPaymentStore(sql, () => {
      relay.notify();
    });
    const received: Envelope[] = [];
    const consumers = await Promise.all([
      startConsumer(broker.channel, {
        queue: COMMANDS.queue,
        handlers: commandHandlers(store, gateway),
        logger,
      }),
      startConsumer(broker.channel, {
        queue: 'stand-in.orders',
        logger,
        handlers: {
          'payments.payment-succeeded': (event) => {
            received.push(event);
            return Promise.resolve();
          },
        },
      }),
    ]);

    const command = requestPayment();
    await publish(broker.channel, [command]);
    const payment = await vi.waitFor(
      async () => {
        const found = await store.findByOrder(command.payload.orderId);
        expect(found).not.toBeNull();
        return found;
      },
      { timeout: 15_000 },
    );
    if (!payment) throw new Error('unreachable');
    gateway.pay(payment.intentId);
    await store.applyEvent(succeeded(payment.intentId), await gateway.retrieve(payment.intentId));

    await vi.waitFor(
      () => {
        expect(received).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    expect(received[0]).toMatchObject({
      correlationId: command.payload.orderId,
      payload: { amount: 500_000 },
    });

    await Promise.all(consumers.map((consumer) => consumer.stop()));
    await relay.stop();
  });
});
