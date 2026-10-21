import { uuidv7 } from '@soukconnect/contracts';
import { type Db, MongoServerError } from 'mongodb';
import type {
  Conversation,
  Message,
  Notification,
  PlannedNotification,
  Side,
} from '../domain/model.js';
import type { Contact, NotificationStore } from '../ports.js';

type ContactDocument = Omit<Contact, 'userId'> & { _id: string; updatedAt: Date };
type ConversationDocument = Omit<Conversation, 'id'> & { _id: string };
type MessageDocument = Omit<Message, 'id'> & { _id: string };
type NotificationDocument = Omit<Notification, 'id'> & { _id: string; emailedAt: Date | null };

const NINETY_DAYS = 90 * 24 * 3600;

function collections(db: Db) {
  return {
    contacts: db.collection<ContactDocument>('contacts'),
    conversations: db.collection<ConversationDocument>('conversations'),
    messages: db.collection<MessageDocument>('messages'),
    notifications: db.collection<NotificationDocument>('notifications'),
  };
}

export async function ensureIndexes(db: Db): Promise<void> {
  const { conversations, messages, notifications } = collections(db);
  // One conversation per buyer and shop (US-12).
  await conversations.createIndex({ buyerId: 1, shopId: 1 }, { unique: true, name: 'pair' });
  await conversations.createIndex({ shopId: 1, lastMessageAt: -1 }, { name: 'shop_inbox' });
  await messages.createIndex({ conversationId: 1, _id: -1 }, { name: 'thread' });
  // Counts the recent messages of an author for the rate limit.
  await messages.createIndex({ authorId: 1, createdAt: -1 }, { name: 'author_recent' });
  await notifications.createIndex({ userId: 1, createdAt: -1 }, { name: 'feed' });
  await notifications.createIndex(
    { createdAt: 1 },
    { name: 'ttl', expireAfterSeconds: NINETY_DAYS },
  );
}

const toConversation = ({ _id, ...rest }: ConversationDocument): Conversation => ({
  id: _id,
  ...rest,
});
const toMessage = ({ _id, ...rest }: MessageDocument): Message => ({ id: _id, ...rest });
const toNotification = ({
  _id,
  emailedAt: _emailed,
  ...rest
}: NotificationDocument): Notification => ({
  id: _id,
  ...rest,
});

export class MongoNotificationStore implements NotificationStore {
  private readonly collections;

  constructor(db: Db) {
    this.collections = collections(db);
  }

  async saveContact(contact: Contact): Promise<void> {
    const { userId, ...fields } = contact;
    await this.collections.contacts.updateOne(
      { _id: userId },
      { $set: { ...fields, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async deleteContact(userId: string): Promise<void> {
    await this.collections.contacts.deleteOne({ _id: userId });
  }

  async getContact(userId: string): Promise<Contact | null> {
    const document = await this.collections.contacts.findOne({ _id: userId });
    if (!document) return null;
    const { _id, updatedAt: _updated, ...fields } = document;
    return { userId: _id, ...fields };
  }

  async openConversation(input: { buyerId: string; shopId: string; productId: string | null }) {
    const { conversations } = this.collections;
    const document = await conversations.findOneAndUpdate(
      { buyerId: input.buyerId, shopId: input.shopId },
      {
        $setOnInsert: {
          _id: uuidv7(),
          productId: input.productId,
          createdAt: new Date(),
          lastMessageAt: null,
          unread: { buyer: 0, shop: 0 },
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!document) throw new Error('Unreachable: upsert returns the document');
    return toConversation(document);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const document = await this.collections.conversations.findOne({ _id: id });
    return document ? toConversation(document) : null;
  }

  async listConversations(
    filter: { buyerId: string } | { shopId: string },
  ): Promise<Conversation[]> {
    const documents = await this.collections.conversations
      .find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(100)
      .toArray();
    return documents.map(toConversation);
  }

  messagesSince(authorId: string, since: Date): Promise<number> {
    return this.collections.messages.countDocuments({ authorId, createdAt: { $gt: since } });
  }

  async addMessage(
    conversation: Conversation,
    side: Side,
    authorId: string,
    body: string,
  ): Promise<Message> {
    const now = new Date();
    const document: MessageDocument = {
      _id: uuidv7(),
      conversationId: conversation.id,
      authorId,
      body,
      createdAt: now,
    };
    await this.collections.messages.insertOne(document);
    const other = side === 'buyer' ? 'shop' : 'buyer';
    await this.collections.conversations.updateOne(
      { _id: conversation.id },
      { $set: { lastMessageAt: now }, $inc: { [`unread.${other}`]: 1 } },
    );
    return toMessage(document);
  }

  async listMessages(
    conversationId: string,
    options: { before?: string; limit: number },
  ): Promise<Message[]> {
    const documents = await this.collections.messages
      .find({ conversationId, ...(options.before ? { _id: { $lt: options.before } } : {}) })
      .sort({ _id: -1 })
      .limit(options.limit)
      .toArray();
    // Newest first from the database, oldest first for reading.
    return documents.reverse().map(toMessage);
  }

  async markRead(conversationId: string, side: Side): Promise<void> {
    await this.collections.conversations.updateOne(
      { _id: conversationId },
      { $set: { [`unread.${side}`]: 0 } },
    );
  }

  async recordNotification(eventId: string, planned: PlannedNotification) {
    const document: NotificationDocument = {
      // One notification per event and person: a redelivered event finds it already there.
      _id: `${eventId}:${planned.userId}`,
      userId: planned.userId,
      type: planned.type,
      orderId: planned.orderId,
      data: planned.data,
      createdAt: new Date(),
      readAt: null,
      emailedAt: null,
    };
    try {
      await this.collections.notifications.insertOne(document);
      return { notification: toNotification(document), created: true, emailed: false };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await this.collections.notifications.findOne({ _id: document._id });
      if (!existing) throw error;
      // Already pushed; the e-mail may still be owed if the previous attempt failed.
      return {
        notification: toNotification(existing),
        created: false,
        emailed: existing.emailedAt !== null,
      };
    }
  }

  async markEmailed(notificationId: string): Promise<void> {
    await this.collections.notifications.updateOne(
      { _id: notificationId },
      { $set: { emailedAt: new Date() } },
    );
  }

  async listNotifications(
    userId: string,
    options: { unreadOnly: boolean; limit: number },
  ): Promise<Notification[]> {
    const documents = await this.collections.notifications
      .find({ userId, ...(options.unreadOnly ? { readAt: null } : {}) })
      .sort({ createdAt: -1 })
      .limit(options.limit)
      .toArray();
    return documents.map(toNotification);
  }

  async readNotifications(userId: string, ids: readonly string[] | 'all'): Promise<number> {
    const result = await this.collections.notifications.updateMany(
      { userId, readAt: null, ...(ids === 'all' ? {} : { _id: { $in: [...ids] } }) },
      { $set: { readAt: new Date() } },
    );
    return result.modifiedCount;
  }
}
