import { createAdapter } from '@socket.io/redis-adapter';
import { connectBroker, declareTopology, startConsumer } from '@soukconnect/messaging';
import {
  closeOnSignals,
  createInternalVerifier,
  createLogger,
  parsePublicKeys,
} from '@soukconnect/service-kit';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { buildApp } from './app.js';
import { loadNotificationsConfig } from './config.js';
import { SmtpMailer } from './mail/smtp-mailer.js';
import { EVENTS, eventHandlers } from './messaging/events.js';
import { ensureIndexes, MongoNotificationStore } from './mongo/store.js';
import { startRealtime } from './realtime/socket.js';

const config = loadNotificationsConfig();
const logger = createLogger('notifications', config.LOG_LEVEL);
const publicKeys = parsePublicKeys(config.INTERNAL_JWT_PUBLIC_KEYS);

const mongo = await MongoClient.connect(config.NOTIFICATIONS_MONGODB_URL);
const db = mongo.db();
await ensureIndexes(db);
const store = new MongoNotificationStore(db);
const mailer = new SmtpMailer(config.SMTP_URL, config.MAIL_FROM);

// The adapter relays the events of every replica to the sockets connected to the others.
const publisher = new Redis(config.REDIS_URL);
const subscriber = publisher.duplicate();

// The socket server needs the HTTP server, the routes need the push: a late binding joins them.
let pushToUser: (userId: string, event: string, payload: unknown) => void = () => undefined;
const app = await buildApp({
  logger,
  store,
  push: {
    toUser(userId, event, payload) {
      pushToUser(userId, event, payload);
    },
  },
  verifyToken: createInternalVerifier({ audience: 'notifications', publicKeys }),
  health: { mongo: () => db.command({ ping: 1 }), redis: () => publisher.ping() },
});
const realtime = startRealtime(app.server, {
  verifyTicket: createInternalVerifier({ audience: 'notifications', publicKeys }),
  logger,
  publicOrigin: new URL(config.PUBLIC_URL).origin,
  adapter: createAdapter(publisher, subscriber),
});
pushToUser = (userId, event, payload) => {
  realtime.push.toUser(userId, event, payload);
};

const broker = await connectBroker({ url: config.RABBITMQ_URL, name: 'notifications', logger });
await declareTopology(broker.channel, [EVENTS]);
const consumer = await startConsumer(broker.channel, {
  queue: EVENTS.queue,
  handlers: eventHandlers({
    store,
    push: realtime.push,
    mailer,
    publicUrl: config.PUBLIC_URL,
    logger,
  }),
  logger,
});

await app.listen({ host: config.HOST, port: config.PORT });

closeOnSignals(logger, async () => {
  await consumer.stop();
  await realtime.io.close();
  await app.close();
  await broker.close();
  mailer.close();
  publisher.disconnect();
  subscriber.disconnect();
  await mongo.close();
});
