import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createEnvelope } from './envelope.js';
import { timestampOf } from './ids.js';
import {
  isMessageType,
  MESSAGE_TYPES,
  MESSAGES,
  type MessageType,
  parsePayload,
} from './messages.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';
const buyerId = '0199f0a4-7a5b-7c1e-9f00-00000000000b';
const shopId = '0199f0a4-7a5b-7c1e-9f00-00000000000c';
const productId = '0199f0a4-7a5b-7c1e-9f00-00000000000d';
const paymentId = '0199f0a4-7a5b-7c1e-9f00-00000000000e';

/** One valid payload per message type: the registry and this list must stay in step. */
const samples: Record<MessageType, unknown> = {
  'catalog.reserve-stock': { orderId, items: [{ productId, quantity: 2 }] },
  'catalog.release-stock': { orderId, reason: 'Payment expired' },
  'catalog.commit-stock': { orderId },
  'payments.request-payment': {
    orderId,
    buyerId,
    amount: 450_000,
    currency: 'MAD',
    shares: [{ shopId, amount: 450_000, commissionBps: 1000 }],
  },
  'payments.cancel-payment': { orderId, reason: 'Payment expired' },
  'payments.refund-payment': { orderId, reason: 'Order cancelled before payment' },
  'catalog.stock-reserved': {
    orderId,
    currency: 'MAD',
    lines: [
      {
        productId,
        shopId,
        title: { fr: 'Tapis Beni Ouarain' },
        unitPrice: 450_000,
        quantity: 1,
        commissionBps: 1000,
      },
    ],
  },
  'catalog.stock-rejected': { orderId, unavailable: [{ productId, requested: 2, available: 0 }] },
  'catalog.product-changed': { productId, shopId, slug: 'tapis-beni-ouarain', status: 'PUBLISHED' },
  'payments.payment-succeeded': { orderId, paymentId, amount: 450_000, currency: 'MAD' },
  'payments.payment-failed': { orderId, paymentId, reason: 'card_declined' },
  'payments.payment-refunded': { orderId, paymentId, amount: 450_000, currency: 'MAD' },
  'orders.order-confirmed': {
    orderId,
    buyerId,
    total: 450_000,
    currency: 'MAD',
    shopIds: [shopId],
  },
  'orders.order-rejected': { orderId, buyerId, unavailable: [productId] },
  'orders.order-cancelled': { orderId, buyerId, reason: 'PAYMENT_EXPIRED' },
  'orders.shipment-updated': {
    orderId,
    buyerId,
    shopId,
    status: 'SHIPPED',
    trackingNumber: 'MA123456789',
  },
};

describe('message registry', () => {
  it.each(MESSAGE_TYPES)('accepts a valid %s', (type) => {
    expect(() => parsePayload(type, samples[type])).not.toThrow();
  });

  it('names every type <service>.<name>', () => {
    for (const type of MESSAGE_TYPES) {
      expect(type).toMatch(/^(catalog|orders|payments)\.[a-z]+(-[a-z]+)*$/);
    }
  });

  it('recognizes known types only', () => {
    expect(isMessageType('catalog.reserve-stock')).toBe(true);
    expect(isMessageType('catalog.unknown')).toBe(false);
    expect(isMessageType('toString')).toBe(false);
    expect(isMessageType(42)).toBe(false);
  });

  it('never accepts a price or an amount that is not integer centimes', () => {
    const reserved = structuredClone(samples['catalog.stock-reserved']) as {
      lines: { unitPrice: number }[];
    };
    reserved.lines[0] = { ...reserved.lines[0], unitPrice: 4500.5 };

    expect(() => parsePayload('catalog.stock-reserved', reserved)).toThrow(ZodError);
    expect(() =>
      parsePayload('payments.payment-succeeded', {
        orderId,
        paymentId,
        amount: -1,
        currency: 'MAD',
      }),
    ).toThrow(ZodError);
    expect(() =>
      parsePayload('payments.payment-succeeded', {
        orderId,
        paymentId,
        amount: 1,
        currency: 'EUR',
      }),
    ).toThrow(ZodError);
  });

  it('bounds the lines of an order', () => {
    const items = Array.from({ length: 51 }, () => ({ productId, quantity: 1 }));
    expect(MESSAGES['catalog.reserve-stock'].safeParse({ orderId, items }).success).toBe(false);
    expect(MESSAGES['catalog.reserve-stock'].safeParse({ orderId, items: [] }).success).toBe(false);
  });

  it('drops unknown fields, so producers may add optional ones', () => {
    expect(parsePayload('catalog.commit-stock', { orderId, addedLater: true })).toEqual({
      orderId,
    });
  });
});

describe('createEnvelope', () => {
  const now = new Date('2026-10-21T08:00:00.000Z');

  it('starts a flow with the given correlation', () => {
    const envelope = createEnvelope(
      'catalog.commit-stock',
      { orderId },
      { correlationId: orderId, now },
    );

    expect(envelope).toMatchObject({
      type: 'catalog.commit-stock',
      occurredAt: '2026-10-21T08:00:00.000Z',
      correlationId: orderId,
      causationId: null,
      payload: { orderId },
    });
    expect(timestampOf(envelope.id)).toBe(now.getTime());
  });

  it('inherits the correlation of the message that caused it', () => {
    const cause = createEnvelope(
      'catalog.reserve-stock',
      samples['catalog.reserve-stock'] as never,
      {
        correlationId: orderId,
      },
    );
    const effect = createEnvelope('catalog.commit-stock', { orderId }, { causedBy: cause });

    expect(effect.correlationId).toBe(orderId);
    expect(effect.causationId).toBe(cause.id);
  });

  it('refuses to build a message a consumer would reject', () => {
    expect(() =>
      createEnvelope('catalog.commit-stock', { orderId: 'not-a-uuid' }, { correlationId: 'x' }),
    ).toThrow(ZodError);
  });
});
