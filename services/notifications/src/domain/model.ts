import type { Actor } from '@soukconnect/service-kit';
import type { Envelope } from '@soukconnect/contracts';

export const MAX_MESSAGE_LENGTH = 2000;
/** Messages per author and minute (US-12): enough to talk, too few to spam. */
export const MESSAGES_PER_MINUTE = 20;

export interface Conversation {
  id: string;
  buyerId: string;
  /** The seller's account: one shop per seller. */
  shopId: string;
  productId: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  unread: { buyer: number; shop: number };
}

export interface Message {
  id: string;
  conversationId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export type Side = 'buyer' | 'shop';

/** Which side of the conversation the actor is on, or null when it is not a participant (I1). */
export function sideOf(conversation: Conversation, actor: Actor): Side | null {
  if (actor.userId !== null && actor.userId === conversation.buyerId) return 'buyer';
  if (actor.shopId !== null && actor.shopId === conversation.shopId) return 'shop';
  return null;
}

/** The person to notify on the other side of a message. */
export function recipientOf(conversation: Conversation, side: Side): string {
  return side === 'buyer' ? conversation.shopId : conversation.buyerId;
}

export const NOTIFICATION_TYPES = [
  'order-confirmed',
  'order-to-prepare',
  'order-rejected',
  'order-cancelled',
  'order-shipped',
  'order-delivered',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  orderId: string;
  data: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
}

export interface PlannedNotification {
  userId: string;
  type: NotificationType;
  orderId: string;
  data: Record<string, unknown>;
  /** Also sent by e-mail: the moments a person must not miss (US-07). */
  email: boolean;
}

/** Who hears about an event of the orders and payments services, and how. */
export function plan(event: Envelope): PlannedNotification[] {
  switch (event.type) {
    case 'orders.order-confirmed': {
      const { orderId, buyerId, total, shopIds } =
        event.payload as Envelope<'orders.order-confirmed'>['payload'];
      return [
        { userId: buyerId, type: 'order-confirmed', orderId, data: { total }, email: true },
        ...shopIds.map((shopId) => ({
          userId: shopId,
          type: 'order-to-prepare' as const,
          orderId,
          data: {},
          email: true,
        })),
      ];
    }
    case 'orders.order-rejected': {
      const { orderId, buyerId, unavailable } =
        event.payload as Envelope<'orders.order-rejected'>['payload'];
      return [
        { userId: buyerId, type: 'order-rejected', orderId, data: { unavailable }, email: false },
      ];
    }
    case 'orders.order-cancelled': {
      const { orderId, buyerId, reason } =
        event.payload as Envelope<'orders.order-cancelled'>['payload'];
      return [
        { userId: buyerId, type: 'order-cancelled', orderId, data: { reason }, email: false },
      ];
    }
    case 'orders.shipment-updated': {
      const { orderId, buyerId, shopId, status, trackingNumber } =
        event.payload as Envelope<'orders.shipment-updated'>['payload'];
      if (status === 'PREPARING') return [];
      return [
        {
          userId: buyerId,
          type: status === 'SHIPPED' ? 'order-shipped' : 'order-delivered',
          orderId,
          data: { shopId, trackingNumber },
          email: status === 'SHIPPED',
        },
      ];
    }
    default:
      return [];
  }
}
