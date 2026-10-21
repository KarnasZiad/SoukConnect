import type { Locale } from '@soukconnect/contracts';
import type {
  Conversation,
  Message,
  Notification,
  PlannedNotification,
  Side,
} from './domain/model.js';
import type { Email } from './mail/templates.js';

export interface Contact {
  userId: string;
  email: string;
  displayName: string;
  locale: Locale;
}

export interface NotificationStore {
  // Contacts: kept only to send e-mails, removed with the account.
  saveContact(contact: Contact): Promise<void>;
  deleteContact(userId: string): Promise<void>;
  getContact(userId: string): Promise<Contact | null>;

  // Conversations (US-12)
  openConversation(input: {
    buyerId: string;
    shopId: string;
    productId: string | null;
  }): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  listConversations(filter: { buyerId: string } | { shopId: string }): Promise<Conversation[]>;
  messagesSince(authorId: string, since: Date): Promise<number>;
  addMessage(
    conversation: Conversation,
    side: Side,
    authorId: string,
    body: string,
  ): Promise<Message>;
  listMessages(
    conversationId: string,
    options: { before?: string; limit: number },
  ): Promise<Message[]>;
  markRead(conversationId: string, side: Side): Promise<void>;

  // Notifications (US-07)
  /**
   * Records a planned notification once per event and person. `created` is false for a
   * redelivered event; `emailed` tells whether its e-mail already went out.
   */
  recordNotification(
    eventId: string,
    planned: PlannedNotification,
  ): Promise<{ notification: Notification; created: boolean; emailed: boolean }>;
  markEmailed(notificationId: string): Promise<void>;
  listNotifications(
    userId: string,
    options: { unreadOnly: boolean; limit: number },
  ): Promise<Notification[]>;
  readNotifications(userId: string, ids: readonly string[] | 'all'): Promise<number>;
}

/** Real-time delivery to every open tab of a person, whatever the replica they are connected to. */
export interface Push {
  toUser(userId: string, event: string, payload: unknown): void;
}

export interface Mailer {
  send(to: string, email: Email): Promise<void>;
}
