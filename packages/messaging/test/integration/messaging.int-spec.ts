import { createEnvelope, type Envelope } from '@soukconnect/contracts';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { MongoClient } from 'mongodb';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Broker, connectBroker } from '../../src/connection.js';
import { startConsumer } from '../../src/consumer.js';
import { PermanentError } from '../../src/errors.js';
import * as mongoAdapter from '../../src/mongo.js';
import { startRelay } from '../../src/outbox.js';
import * as pgAdapter from '../../src/postgres.js';
import { publish } from '../../src/publisher.js';
import { declareTopology, deadQueueOf } from '../../src/topology.js';
import { silentLogger } from '../fake-channel.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';
const commit = (id = orderId): Envelope =>
  createEnvelope('catalog.commit-stock', { orderId: id }, { correlationId: id });

let rabbit: StartedRabbitMQContainer;
let pg: StartedPostgreSqlContainer;
let mongoContainer: StartedMongoDBContainer;
let sql: postgres.Sql;
let mongo: MongoClient;
let broker: Broker;
let queueIndex = 0;

beforeAll(async () => {
  [rabbit, pg, mongoContainer] = await Promise.all([
    new RabbitMQContainer('rabbitmq:4.3-alpine').start(),
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new MongoDBContainer('mongo:8.0').start(),
  ]);
  sql = postgres(pg.getConnectionUri(), { onnotice: () => undefined });
  await sql.unsafe(pgAdapter.MESSAGING_SCHEMA);
  await sql`create table effects (order_id uuid not null)`;
  mongo = await MongoClient.connect(mongoContainer.getConnectionString(), {
    directConnection: true,
  });
  await mongoAdapter.ensureMessagingIndexes(mongo.db('catalog'));
  broker = await connectBroker({
    url: rabbit.getAmqpUrl(),
    name: 'messaging-tests',
    logger: silentLogger(),
    onLost: (error) => {
      throw error;
    },
  });
});

afterAll(async () => {
  await broker.close();
  await sql.end();
  await mongo.close();
  await Promise.all([rabbit.stop(), pg.stop(), mongoContainer.stop()]);
});

beforeEach(async () => {
  await sql`truncate outbox, inbox, effects`;
});

/** A fresh queue per test, bound to the commit command, with short retry delays. */
async function freshQueue(retryDelaysMs = [200, 200]): Promise<string> {
  queueIndex += 1;
  const queue = `test.queue.${queueIndex}`;
  await declareTopology(broker.channel, [
    { queue, bindings: ['catalog.commit-stock'], retryDelaysMs },
  ]);
  return queue;
}

async function deadLetters(queue: string): Promise<number> {
  const { messageCount } = await broker.channel.checkQueue(deadQueueOf(queue));
  return messageCount;
}

describe('PostgreSQL outbox and inbox over RabbitMQ', () => {
  it('delivers a message written in a transaction, and handles it once despite a duplicate', async () => {
    const queue = await freshQueue();
    const consumer = await startConsumer(broker.channel, {
      queue,
      logger: silentLogger(),
      handlers: {
        'catalog.commit-stock': async (envelope) => {
          await sql.begin(async (tx) => {
            if (!(await pgAdapter.markProcessed(tx, queue, envelope.id))) return;
            await tx`insert into effects (order_id) values (${envelope.payload.orderId})`;
          });
        },
      },
    });
    const envelope = commit();
    await sql.begin((tx) => pgAdapter.enqueue(tx, envelope));
    const relay = startRelay({
      store: pgAdapter.postgresOutbox(sql),
      send: (envelopes) => publish(broker.channel, envelopes),
      logger: silentLogger(),
      idleDelayMs: 50,
    });

    await vi.waitFor(async () => {
      expect((await sql`select * from effects`).length).toBe(1);
    });
    // The broker may deliver a message twice: the inbox makes the second one harmless.
    await publish(broker.channel, [envelope]);
    await vi.waitFor(async () => {
      expect((await sql`select * from inbox`).length).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await sql`select * from effects`).length).toBe(1);
    expect((await sql`select published_at from outbox`)[0]?.published_at).toBeInstanceOf(Date);
    await relay.stop();
    await consumer.stop();
  });

  it('never publishes a message whose transaction rolled back', async () => {
    await sql
      .begin(async (tx) => {
        await pgAdapter.enqueue(tx, commit());
        throw new Error('business rule violated');
      })
      .catch(() => undefined);

    expect((await sql`select * from outbox`).length).toBe(0);
  });

  it('lets concurrent relays share the outbox without publishing a message twice', async () => {
    const queue = await freshQueue();
    const received: string[] = [];
    const consumer = await startConsumer(broker.channel, {
      queue,
      logger: silentLogger(),
      prefetch: 50,
      handlers: {
        'catalog.commit-stock': (envelope) => {
          received.push(envelope.id);
          return Promise.resolve();
        },
      },
    });
    const envelopes = Array.from({ length: 60 }, () => commit(crypto.randomUUID()));
    await sql.begin((tx) => pgAdapter.enqueue(tx, envelopes));
    const relays = [1, 2, 3].map(() =>
      startRelay({
        store: pgAdapter.postgresOutbox(sql),
        send: (batch) => publish(broker.channel, batch),
        logger: silentLogger(),
        batchSize: 7,
        idleDelayMs: 20,
      }),
    );

    await vi.waitFor(() => {
      expect(received).toHaveLength(60);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(new Set(received).size).toBe(60);
    expect(received).toHaveLength(60);
    expect((await sql`select * from outbox where published_at is null`).length).toBe(0);
    await Promise.all(relays.map((relay) => relay.stop()));
    await consumer.stop();
  });
});

describe('retries and dead letters on a real broker', () => {
  it('delivers a failed message again after the retry delay', async () => {
    const queue = await freshQueue([200]);
    const attempts: number[] = [];
    const consumer = await startConsumer(broker.channel, {
      queue,
      logger: silentLogger(),
      retryDelaysMs: [200],
      handlers: {
        'catalog.commit-stock': (_envelope, context) => {
          attempts.push(context.attempt);
          return context.attempt === 0 ? Promise.reject(new Error('transient')) : Promise.resolve();
        },
      },
    });

    await publish(broker.channel, [commit()]);

    await vi.waitFor(() => {
      expect(attempts).toEqual([0, 1]);
    });
    expect(await deadLetters(queue)).toBe(0);
    await consumer.stop();
  });

  it('dead-letters a message that keeps failing, and a permanent failure at once', async () => {
    const queue = await freshQueue([100, 100]);
    let calls = 0;
    const consumer = await startConsumer(broker.channel, {
      queue,
      logger: silentLogger(),
      retryDelaysMs: [100, 100],
      handlers: {
        'catalog.commit-stock': (envelope) => {
          calls += 1;
          return Promise.reject(
            envelope.payload.orderId === orderId
              ? new Error('always failing')
              : new PermanentError('out of sequence'),
          );
        },
      },
    });

    await publish(broker.channel, [commit(), commit(crypto.randomUUID())]);

    await vi.waitFor(async () => {
      expect(await deadLetters(queue)).toBe(2);
    });
    // Three deliveries of the failing one (first try and two retries), one of the permanent one.
    expect(calls).toBe(4);
    const dead = await broker.channel.get(deadQueueOf(queue), { noAck: true });
    expect(dead && typeof dead.properties.headers?.['x-dead-reason']).toBe('string');
    await consumer.stop();
  });
});

describe('MongoDB outbox and inbox', () => {
  it('publishes what a committed transaction wrote, and nothing from an aborted one', async () => {
    const db = mongo.db('catalog');
    const queue = await freshQueue();
    const received: string[] = [];
    const consumer = await startConsumer(broker.channel, {
      queue,
      logger: silentLogger(),
      handlers: {
        'catalog.commit-stock': (envelope) => {
          received.push(envelope.id);
          return Promise.resolve();
        },
      },
    });
    const kept = commit(crypto.randomUUID());
    const dropped = commit(crypto.randomUUID());
    const session = mongo.startSession();
    try {
      await session.withTransaction(() => mongoAdapter.enqueue(db, kept, session));
      await session
        .withTransaction(async () => {
          await mongoAdapter.enqueue(db, dropped, session);
          throw new Error('business rule violated');
        })
        .catch(() => undefined);
    } finally {
      await session.endSession();
    }
    const relay = startRelay({
      store: mongoAdapter.mongoOutbox(db),
      send: (envelopes) => publish(broker.channel, envelopes),
      logger: silentLogger(),
      idleDelayMs: 50,
    });

    await vi.waitFor(() => {
      expect(received).toEqual([kept.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toEqual([kept.id]);
    await relay.stop();
    await consumer.stop();
  });

  it('recognizes a message already handled by a consumer', async () => {
    const db = mongo.db('catalog');
    const id = crypto.randomUUID();
    const run = async () => {
      const session = mongo.startSession();
      try {
        let first = false;
        await session.withTransaction(async () => {
          first = await mongoAdapter.markProcessed(db, 'catalog.commands', id, session);
          if (!first) await session.abortTransaction();
        });
        return first;
      } finally {
        await session.endSession();
      }
    };

    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
  });
});
