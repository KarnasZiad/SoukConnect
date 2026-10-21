import { z } from 'zod';
import { localizedText } from './locales.js';
import { amount, commissionBps, currency } from './money.js';
import { CANCELLATION_REASONS, PRODUCT_STATUSES, SHIPMENT_STATUSES } from './statuses.js';

const id = z.uuid();
const quantity = z.int().min(1).max(99);
const reason = z.string().min(1).max(200);
/** An order holds at most 50 lines: bounds every message that carries them. */
const lines = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(50);

const orderLine = z.object({
  productId: id,
  shopId: id,
  title: localizedText(200),
  unitPrice: amount,
  quantity,
  commissionBps,
});

/**
 * Every message of the platform, keyed by its routing key `<service>.<name>`.
 * Commands (imperative: `reserve-stock`) have one recipient; events (past tense:
 * `stock-reserved`) have any number of subscribers.
 *
 * Tolerant reader: unknown fields are dropped, so a producer may add optional fields. A field that
 * becomes required, or changes meaning, needs a new message type.
 */
export const MESSAGES = {
  // Commands of the saga, sent by orders
  'catalog.reserve-stock': z.object({
    orderId: id,
    items: lines(z.object({ productId: id, quantity })),
  }),
  'catalog.release-stock': z.object({ orderId: id, reason }),
  'catalog.commit-stock': z.object({ orderId: id }),
  'payments.request-payment': z.object({
    orderId: id,
    buyerId: id,
    amount,
    currency,
    shares: lines(z.object({ shopId: id, amount, commissionBps })),
  }),
  'payments.cancel-payment': z.object({ orderId: id, reason }),
  'payments.refund-payment': z.object({ orderId: id, reason }),

  // Facts published by catalog
  'catalog.stock-reserved': z.object({ orderId: id, currency, lines: lines(orderLine) }),
  'catalog.stock-rejected': z.object({
    orderId: id,
    // Totals per product: the same product may appear on several lines.
    unavailable: lines(
      z.object({ productId: id, requested: z.int().min(1).max(10_000), available: z.int().min(0) }),
    ),
  }),
  'catalog.product-changed': z.object({
    productId: id,
    shopId: id,
    slug: z.string().min(1).max(120),
    status: z.enum(PRODUCT_STATUSES),
  }),

  // Facts published by payments
  'payments.payment-succeeded': z.object({ orderId: id, paymentId: id, amount, currency }),
  'payments.payment-failed': z.object({ orderId: id, paymentId: id, reason }),
  'payments.payment-refunded': z.object({ orderId: id, paymentId: id, amount, currency }),

  // Facts published by orders
  'orders.order-confirmed': z.object({
    orderId: id,
    buyerId: id,
    total: amount,
    currency,
    shopIds: lines(id),
  }),
  'orders.order-rejected': z.object({ orderId: id, buyerId: id, unavailable: lines(id) }),
  'orders.order-cancelled': z.object({
    orderId: id,
    buyerId: id,
    reason: z.enum(CANCELLATION_REASONS),
  }),
  'orders.shipment-updated': z.object({
    orderId: id,
    buyerId: id,
    shopId: id,
    status: z.enum(SHIPMENT_STATUSES),
    trackingNumber: z.string().min(1).max(64).nullable(),
  }),
} as const satisfies Record<`${string}.${string}`, z.ZodType>;

export type MessageType = keyof typeof MESSAGES;
export type MessagePayload<T extends MessageType> = z.infer<(typeof MESSAGES)[T]>;
export const MESSAGE_TYPES = Object.keys(MESSAGES) as MessageType[];

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && Object.hasOwn(MESSAGES, value);
}

/** Validates a payload against the schema of its type; throws a ZodError when it does not match. */
export function parsePayload<T extends MessageType>(type: T, payload: unknown): MessagePayload<T> {
  return MESSAGES[type].parse(payload) as MessagePayload<T>;
}
