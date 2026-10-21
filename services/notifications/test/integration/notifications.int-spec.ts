import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import { createEnvelope } from '@soukconnect/contracts';
import { connectBroker, declareTopology, publish, startConsumer } from '@soukconnect/messaging';
import { createInternalVerifier, createLogger, signInternalToken } from '@soukconnect/service-kit';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { type Db, MongoClient } from 'mongodb';
import { io as connect } from 'socket.io-client';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../../src/mail/smtp-mailer.js';
import { EVENTS, eventHandlers } from '../../src/messaging/events.js';
import { ensureIndexes, MongoNotificationStore } from '../../src/mongo/store.js';
import { startRealtime } from '../../src/realtime/socket.js';
import { buyer, buyerId, keys, orderId, sellerId } from '../fakes.js';

const logger = createLogger('notifications-it', 'silent');

let mongoContainer: StartedMongoDBContainer;
let redisContainer: StartedRedisContainer;
let rabbit: StartedRabbitMQContainer;
let mailpit: StartedTestContainer;
let mongo: MongoClient;
let db: Db;
const redisClients: Redis[] = [];

beforeAll(async () => {
  [mongoContainer, redisContainer, rabbit, mailpit] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    new RedisContainer('redis:7.4-alpine').start(),
    new RabbitMQContainer('rabbitmq:4.3-alpine').start(),
    new GenericContainer('axllent/mailpit:v1.31')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/livez', 8025))
      .start(),
  ]);
  mongo = await MongoClient.connect(mongoContainer.getConnectionString(), {
    directConnection: true,
  });
  db = mongo.db('notifications');
  await ensureIndexes(db);
});

afterAll(async () => {
  for (const client of redisClients) client.disconnect();
  await mongo.close();
  await Promise.all([mongoContainer.stop(), redisContainer.stop(), rabbit.stop(), mailpit.stop()]);
});

function redis(): Redis {
  const client = new Redis(redisContainer.getConnectionUrl());
  redisClients.push(client);
  return client;
}

async function replica(publicKeys: Awaited<ReturnType<typeof keys>>['publicKeys']) {
  const http = createServer();
  const publisher = redis();
  const realtime = startRealtime(http, {
    verifyTicket: createInternalVerifier({ audience: 'notifications', publicKeys }),
    logger,
    publicOrigin: 'https://soukconnect.test',
    adapter: createAdapter(publisher, publisher.duplicate()),
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { realtime, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

describe('the MongoDB store', () => {
  it('opens a single conversation for concurrent first messages', async () => {
    const store = new MongoNotificationStore(db);
    const input = { buyerId, shopId: sellerId, productId: null };

    const opened = await Promise.all([
      store.openConversation(input),
      store.openConversation(input),
      store.openConversation(input),
    ]);

    expect(new Set(opened.map((conversation) => conversation.id)).size).toBe(1);
  });

  it('pages a thread from the newest backwards and counts unread messages per side', async () => {
    const store = new MongoNotificationStore(db);
    const conversation = await store.openConversation({
      buyerId,
      shopId: crypto.randomUUID(),
      productId: null,
    });
    for (let index = 0; index < 5; index += 1)
      await store.addMessage(conversation, 'buyer', buyerId, `message ${index}`);

    const last = await store.listMessages(conversation.id, { limit: 2 });
    expect(last.map((message) => message.body)).toEqual(['message 3', 'message 4']);
    const before = await store.listMessages(conversation.id, {
      limit: 2,
      before: last[0]?.id ?? '',
    });
    expect(before.map((message) => message.body)).toEqual(['message 1', 'message 2']);
    expect((await store.getConversation(conversation.id))?.unread).toEqual({ buyer: 0, shop: 5 });
    expect(
      await store.messagesSince(buyerId, new Date(Date.now() - 60_000)),
    ).toBeGreaterThanOrEqual(5);
  });

  it('records a notification once per event and person', async () => {
    const store = new MongoNotificationStore(db);
    const planned = {
      userId: buyerId,
      type: 'order-shipped' as const,
      orderId,
      data: {},
      email: true,
    };

    const first = await store.recordNotification('evt-1', planned);
    const again = await store.recordNotification('evt-1', planned);
    await store.markEmailed(first.notification.id);
    const third = await store.recordNotification('evt-1', planned);

    expect([first.created, again.created, third.created]).toEqual([true, false, false]);
    expect([first.emailed, again.emailed, third.emailed]).toEqual([false, false, true]);
  });
});

describe('several replicas', () => {
  it('delivers an event pushed on one replica to a socket connected to another', async () => {
    const { signing, publicKeys } = await keys();
    const [first, second] = await Promise.all([replica(publicKeys), replica(publicKeys)]);
    const socket = connect(second.url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { ticket: await signInternalToken(signing, 'notifications', buyer, 60) },
    });
    await new Promise<void>((resolve) =>
      socket.on('connect', () => {
        resolve();
      }),
    );
    const received: unknown[] = [];
    socket.on('notification', (payload: unknown) => received.push(payload));

    first.realtime.push.toUser(buyerId, 'notification', { type: 'order-shipped' });

    await expect.poll(() => received, { timeout: 10_000 }).toEqual([{ type: 'order-shipped' }]);
    socket.close();
    await Promise.all([first.realtime.io.close(), second.realtime.io.close()]);
  });
});

describe('from RabbitMQ to the inbox', () => {
  it('e-mails the buyer of a confirmed order through SMTP', async () => {
    const store = new MongoNotificationStore(db);
    await store.saveContact({
      userId: buyerId,
      email: 'amina@example.ma',
      displayName: 'Amina',
      locale: 'fr',
    });
    const mailer = new SmtpMailer(
      `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
      'SoukConnect <commandes@soukconnect.ma>',
    );
    const broker = await connectBroker({
      url: rabbit.getAmqpUrl(),
      name: 'notifications-it',
      logger,
      onLost: (error) => {
        throw error;
      },
    });
    await declareTopology(broker.channel, [EVENTS]);
    const pushed: string[] = [];
    const consumer = await startConsumer(broker.channel, {
      queue: EVENTS.queue,
      logger,
      handlers: eventHandlers({
        store,
        push: { toUser: (userId) => pushed.push(userId) },
        mailer,
        publicUrl: 'https://soukconnect.ma',
        logger,
      }),
    });

    await publish(broker.channel, [
      createEnvelope(
        'orders.order-confirmed',
        { orderId, buyerId, total: 125_000, currency: 'MAD', shopIds: [sellerId] },
        { correlationId: orderId },
      ),
    ]);

    const inbox = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/messages`;
    await expect
      .poll(
        async () =>
          (
            (await (await fetch(inbox)).json()) as {
              messages: { To: { Address: string }[]; Subject: string }[];
            }
          ).messages,
        { timeout: 15_000 },
      )
      .toEqual([
        expect.objectContaining({
          To: [expect.objectContaining({ Address: 'amina@example.ma' })],
          Subject: `Commande ${orderId.slice(0, 8).toUpperCase()} confirmée`,
        }),
      ]);
    expect(pushed).toEqual([buyerId, sellerId]);

    await consumer.stop();
    await broker.close();
    mailer.close();
  });
});
