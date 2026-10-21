import { uuidv7 } from '@soukconnect/contracts';
import {
  type Actor,
  createInternalVerifier,
  createLogger,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
  signInternalToken,
} from '@soukconnect/service-kit';
import { buildApp } from '../src/app.js';
import type {
  Conversation,
  Message,
  Notification,
  PlannedNotification,
  Side,
} from '../src/domain/model.js';
import type { Email } from '../src/mail/templates.js';
import type { Contact, Mailer, NotificationStore, Push } from '../src/ports.js';

export const buyerId = '0199f0a4-7a5b-7c1e-9f00-0000000000b1';
export const otherBuyerId = '0199f0a4-7a5b-7c1e-9f00-0000000000b2';
export const sellerId = '0199f0a4-7a5b-7c1e-9f00-0000000000c1';
export const otherSellerId = '0199f0a4-7a5b-7c1e-9f00-0000000000c2';
export const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';

export const buyer: Actor = { userId: buyerId, role: 'buyer', shopId: null };
export const otherBuyer: Actor = { userId: otherBuyerId, role: 'buyer', shopId: null };
export const seller: Actor = { userId: sellerId, role: 'seller', shopId: sellerId };
export const otherSeller: Actor = { userId: otherSellerId, role: 'seller', shopId: otherSellerId };

export class MemoryStore implements NotificationStore {
  contacts = new Map<string, Contact>();
  conversations = new Map<string, Conversation>();
  messages: Message[] = [];
  notifications = new Map<string, Notification & { emailed: boolean }>();

  saveContact(contact: Contact) {
    this.contacts.set(contact.userId, contact);
    return Promise.resolve();
  }
  deleteContact(userId: string) {
    this.contacts.delete(userId);
    return Promise.resolve();
  }
  getContact(userId: string) {
    return Promise.resolve(this.contacts.get(userId) ?? null);
  }
  openConversation(input: { buyerId: string; shopId: string; productId: string | null }) {
    const existing = [...this.conversations.values()].find(
      (conversation) =>
        conversation.buyerId === input.buyerId && conversation.shopId === input.shopId,
    );
    if (existing) return Promise.resolve(existing);
    const conversation: Conversation = {
      id: uuidv7(),
      ...input,
      createdAt: new Date(),
      lastMessageAt: null,
      unread: { buyer: 0, shop: 0 },
    };
    this.conversations.set(conversation.id, conversation);
    return Promise.resolve(conversation);
  }
  getConversation(id: string) {
    return Promise.resolve(this.conversations.get(id) ?? null);
  }
  listConversations(filter: { buyerId: string } | { shopId: string }) {
    return Promise.resolve(
      [...this.conversations.values()].filter((conversation) =>
        'buyerId' in filter
          ? conversation.buyerId === filter.buyerId
          : conversation.shopId === filter.shopId,
      ),
    );
  }
  messagesSince(authorId: string, since: Date) {
    return Promise.resolve(
      this.messages.filter((message) => message.authorId === authorId && message.createdAt > since)
        .length,
    );
  }
  addMessage(conversation: Conversation, side: Side, authorId: string, body: string) {
    const message: Message = {
      id: uuidv7(),
      conversationId: conversation.id,
      authorId,
      body,
      createdAt: new Date(),
    };
    this.messages.push(message);
    conversation.lastMessageAt = message.createdAt;
    conversation.unread[side === 'buyer' ? 'shop' : 'buyer'] += 1;
    return Promise.resolve(message);
  }
  listMessages(conversationId: string, options: { before?: string; limit: number }) {
    const thread = this.messages.filter(
      (message) =>
        message.conversationId === conversationId &&
        (!options.before || message.id < options.before),
    );
    return Promise.resolve(thread.slice(-options.limit));
  }
  markRead(conversationId: string, side: Side) {
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.unread[side] = 0;
    return Promise.resolve();
  }
  recordNotification(eventId: string, planned: PlannedNotification) {
    const id = `${eventId}:${planned.userId}`;
    const existing = this.notifications.get(id);
    if (existing)
      return Promise.resolve({ notification: existing, created: false, emailed: existing.emailed });
    const notification = {
      id,
      userId: planned.userId,
      type: planned.type,
      orderId: planned.orderId,
      data: planned.data,
      createdAt: new Date(),
      readAt: null,
      emailed: false,
    };
    this.notifications.set(id, notification);
    return Promise.resolve({ notification, created: true, emailed: false });
  }
  markEmailed(notificationId: string) {
    const notification = this.notifications.get(notificationId);
    if (notification) notification.emailed = true;
    return Promise.resolve();
  }
  listNotifications(userId: string, options: { unreadOnly: boolean; limit: number }) {
    return Promise.resolve(
      [...this.notifications.values()]
        .filter(
          (notification) =>
            notification.userId === userId && (!options.unreadOnly || notification.readAt === null),
        )
        .slice(0, options.limit),
    );
  }
  readNotifications(userId: string, ids: readonly string[] | 'all') {
    let count = 0;
    for (const notification of this.notifications.values()) {
      if (
        notification.userId === userId &&
        notification.readAt === null &&
        (ids === 'all' || ids.includes(notification.id))
      ) {
        notification.readAt = new Date();
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

export class FakePush implements Push {
  pushed: { userId: string; event: string; payload: unknown }[] = [];
  toUser(userId: string, event: string, payload: unknown): void {
    this.pushed.push({ userId, event, payload });
  }
}

export class FakeMailer implements Mailer {
  sent: { to: string; email: Email }[] = [];
  failures = 0;
  send(to: string, email: Email): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('SMTP unavailable'));
    }
    this.sent.push({ to, email });
    return Promise.resolve();
  }
}

export async function keys() {
  const { privateJwk, publicJwk } = await generateSigningKeys('test');
  return {
    signing: await importSigningKey(JSON.stringify(privateJwk)),
    publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
  };
}

export async function testApp() {
  const { signing, publicKeys } = await keys();
  const store = new MemoryStore();
  const push = new FakePush();
  const app = await buildApp({
    logger: createLogger('notifications-test', 'silent'),
    store,
    push,
    verifyToken: createInternalVerifier({ audience: 'notifications', publicKeys }),
  });
  async function call(
    actor: Actor,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await signInternalToken(signing, 'notifications', actor)}`,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  return { app, store, push, call };
}
