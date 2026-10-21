import { LOCALES } from '@soukconnect/contracts';
import { type createService, notFound, ProblemError, requireUser } from '@soukconnect/service-kit';
import { z } from 'zod';
import {
  type Conversation,
  MAX_MESSAGE_LENGTH,
  type Message,
  MESSAGES_PER_MINUTE,
  type Notification,
  NOTIFICATION_TYPES,
  recipientOf,
  sideOf,
} from '../domain/model.js';
import type { NotificationStore, Push } from '../ports.js';

type App = Awaited<ReturnType<typeof createService>>;

export interface RouteDeps {
  store: NotificationStore;
  push: Push;
  now?: () => Date;
}

const idParams = z.object({ id: z.uuid() }).strict();

const conversationView = z.object({
  id: z.uuid(),
  buyerId: z.uuid(),
  shopId: z.uuid(),
  productId: z.uuid().nullable(),
  lastMessageAt: z.iso.datetime().nullable(),
  /** Unread messages for the side of the reader. */
  unread: z.int(),
});

const messageView = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  authorId: z.uuid(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

const notificationView = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  orderId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});

const toMessageView = (message: Message): z.infer<typeof messageView> => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
});

const toNotificationView = (notification: Notification): z.infer<typeof notificationView> => ({
  id: notification.id,
  type: notification.type,
  orderId: notification.orderId,
  data: notification.data,
  createdAt: notification.createdAt.toISOString(),
  readAt: notification.readAt?.toISOString() ?? null,
});

export function registerRoutes(app: App, deps: RouteDeps): void {
  const { store, push } = deps;
  const now = deps.now ?? (() => new Date());

  function toConversationView(
    conversation: Conversation,
    side: 'buyer' | 'shop',
  ): z.infer<typeof conversationView> {
    return {
      id: conversation.id,
      buyerId: conversation.buyerId,
      shopId: conversation.shopId,
      productId: conversation.productId,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      unread: conversation.unread[side],
    };
  }

  /** The conversation and the side of the reader; someone else's answers like nothing (I1). */
  async function participantOf(request: Parameters<typeof requireUser>[0], id: string) {
    const actor = requireUser(request);
    const conversation = await store.getConversation(id);
    const side = conversation ? sideOf(conversation, actor) : null;
    if (!conversation || !side) throw notFound();
    return { actor, conversation, side };
  }

  // ---- Contacts: written by the gateway at sign-up, removed with the account

  app.put(
    '/contacts/me',
    {
      schema: {
        tags: ['contacts'],
        body: z
          .object({
            email: z.email().max(254),
            displayName: z.string().trim().min(1).max(60),
            locale: z.enum(LOCALES),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const { userId } = requireUser(request);
      await store.saveContact({ userId, ...request.body });
      return reply.code(204).send();
    },
  );

  app.delete('/contacts/me', { schema: { tags: ['contacts'] } }, async (request, reply) => {
    await store.deleteContact(requireUser(request).userId);
    return reply.code(204).send();
  });

  // ---- Conversations (US-12)

  app.post(
    '/conversations',
    {
      schema: {
        tags: ['conversations'],
        body: z.object({ shopId: z.uuid(), productId: z.uuid().optional() }).strict(),
        response: { 200: conversationView },
      },
    },
    async (request) => {
      const { userId } = requireUser(request, 'buyer');
      const conversation = await store.openConversation({
        buyerId: userId,
        shopId: request.body.shopId,
        productId: request.body.productId ?? null,
      });
      return toConversationView(conversation, 'buyer');
    },
  );

  app.get(
    '/conversations',
    {
      schema: {
        tags: ['conversations'],
        response: { 200: z.object({ items: z.array(conversationView) }) },
      },
    },
    async (request) => {
      const actor = requireUser(request, 'buyer', 'seller');
      const side = actor.role === 'seller' ? 'shop' : 'buyer';
      const conversations = await store.listConversations(
        side === 'shop' ? { shopId: actor.shopId ?? actor.userId } : { buyerId: actor.userId },
      );
      return { items: conversations.map((conversation) => toConversationView(conversation, side)) };
    },
  );

  app.get(
    '/conversations/:id/messages',
    {
      schema: {
        tags: ['conversations'],
        params: idParams,
        querystring: z
          .object({
            before: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(30),
          })
          .strict(),
        response: { 200: z.object({ items: z.array(messageView) }) },
      },
    },
    async (request) => {
      await participantOf(request, request.params.id);
      const messages = await store.listMessages(request.params.id, {
        limit: request.query.limit,
        ...(request.query.before ? { before: request.query.before } : {}),
      });
      return { items: messages.map(toMessageView) };
    },
  );

  app.post(
    '/conversations/:id/messages',
    {
      schema: {
        tags: ['conversations'],
        params: idParams,
        body: z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) }).strict(),
        response: { 201: messageView },
      },
    },
    async (request, reply) => {
      const { actor, conversation, side } = await participantOf(request, request.params.id);
      // Counted in the database: the limit holds across replicas and restarts.
      const recent = await store.messagesSince(actor.userId, new Date(now().getTime() - 60_000));
      if (recent >= MESSAGES_PER_MINUTE) {
        void reply.header('retry-after', '60');
        throw new ProblemError(429, 'Too Many Requests', 'Too many messages, wait a minute');
      }
      const message = await store.addMessage(conversation, side, actor.userId, request.body.body);
      const view = toMessageView(message);
      push.toUser(recipientOf(conversation, side), 'message', view);
      push.toUser(actor.userId, 'message', view);
      return reply.code(201).send(view);
    },
  );

  app.post(
    '/conversations/:id/read',
    { schema: { tags: ['conversations'], params: idParams } },
    async (request, reply) => {
      const { conversation, side } = await participantOf(request, request.params.id);
      await store.markRead(conversation.id, side);
      return reply.code(204).send();
    },
  );

  // ---- Notifications (US-07)

  app.get(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        querystring: z.object({ unread: z.enum(['true', 'false']).default('false') }).strict(),
        response: { 200: z.object({ items: z.array(notificationView) }) },
      },
    },
    async (request) => {
      const { userId } = requireUser(request);
      const notifications = await store.listNotifications(userId, {
        unreadOnly: request.query.unread === 'true',
        limit: 50,
      });
      return { items: notifications.map(toNotificationView) };
    },
  );

  app.post(
    '/notifications/read',
    {
      schema: {
        tags: ['notifications'],
        body: z
          .object({ ids: z.array(z.string().min(1).max(120)).min(1).max(100).or(z.literal('all')) })
          .strict(),
        response: { 200: z.object({ read: z.int() }) },
      },
    },
    async (request) => {
      const { userId } = requireUser(request);
      return { read: await store.readNotifications(userId, request.body.ids) };
    },
  );
}
