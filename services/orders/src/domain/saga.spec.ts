import { PermanentError } from '@soukconnect/messaging';
import { describe, expect, it } from 'vitest';
import {
  awaitingPayment,
  buyerId,
  confirmed,
  lines,
  order,
  potId,
  rugId,
  shopA,
  shopB,
} from '../../test/fixtures.js';
import {
  cancelByBuyer,
  expire,
  onPaymentFailed,
  onPaymentSucceeded,
  onStockRejected,
  onStockReserved,
  PAYMENT_WINDOW_MS,
  updateShipment,
} from './saga.js';

const now = new Date('2026-10-21T08:00:00Z');
const paymentId = '0199f0a4-7a5b-7c1e-9f00-0000000000e1';
const reserved = { orderId: order().id, currency: 'MAD' as const, lines };
const types = (decision: { messages: { type: string }[] }) =>
  decision.messages.map((message) => message.type);

describe('stock reserved', () => {
  it('waits for the payment, at the prices frozen by the catalog, with each shop share', () => {
    const decision = onStockReserved(order(), reserved, now);

    expect(decision).toMatchObject({
      status: 'AWAITING_PAYMENT',
      total: 500_000,
      lines,
      paymentDeadline: new Date(now.getTime() + PAYMENT_WINDOW_MS),
    });
    expect(decision.messages).toEqual([
      {
        type: 'payments.request-payment',
        payload: {
          orderId: order().id,
          buyerId,
          amount: 500_000,
          currency: 'MAD',
          shares: [
            { shopId: shopA, amount: 450_000, commissionBps: 1000 },
            { shopId: shopB, amount: 50_000, commissionBps: 800 },
          ],
        },
      },
    ]);
  });

  it('refuses a reservation that does not match what the buyer asked for', () => {
    const tampered = { ...reserved, lines: [{ ...lines[0], quantity: 2 } as (typeof lines)[0]] };

    expect(() => onStockReserved(order(), tampered, now)).toThrow(PermanentError);
    expect(() =>
      onStockReserved(order(), { ...reserved, lines: [...lines, ...lines] }, now),
    ).toThrow(/does not match/);
  });

  it('gives the stock back when the buyer cancelled meanwhile', () => {
    const decision = onStockReserved(order({ status: 'CANCELLED' }), reserved, now);
    expect(decision.status).toBeUndefined();
    expect(types(decision)).toEqual(['catalog.release-stock']);
  });

  it('is out of sequence anywhere else', () => {
    expect(() => onStockReserved(awaitingPayment(), reserved, now)).toThrow(/out of sequence/);
  });
});

describe('stock rejected', () => {
  it('rejects the order, listing the unavailable products, with nothing to compensate', () => {
    const decision = onStockRejected(order(), {
      orderId: order().id,
      unavailable: [{ productId: rugId, requested: 1, available: 0 }],
    });

    expect(decision.status).toBe('REJECTED');
    expect(decision.messages).toEqual([
      {
        type: 'orders.order-rejected',
        payload: { orderId: order().id, buyerId, unavailable: [rugId] },
      },
    ]);
  });

  it('changes nothing on a cancelled order, and is out of sequence once reserved', () => {
    const rejected = {
      orderId: order().id,
      unavailable: [{ productId: potId, requested: 2, available: 1 }],
    };
    expect(onStockRejected(order({ status: 'CANCELLED' }), rejected)).toEqual({ messages: [] });
    expect(() => onStockRejected(awaitingPayment(), rejected)).toThrow(PermanentError);
  });
});

describe('payment succeeded', () => {
  const paid = { orderId: order().id, paymentId, amount: 500_000, currency: 'MAD' as const };

  it('confirms the order, commits the stock and opens one shipment per shop', () => {
    const decision = onPaymentSucceeded(awaitingPayment(), paid);

    expect(decision.status).toBe('CONFIRMED');
    expect(decision.paymentDeadline).toBeNull();
    expect(decision.shipments?.map((shipment) => [shipment.shopId, shipment.status])).toEqual([
      [shopA, 'PREPARING'],
      [shopB, 'PREPARING'],
    ]);
    expect(decision.messages).toEqual([
      { type: 'catalog.commit-stock', payload: { orderId: order().id } },
      {
        type: 'orders.order-confirmed',
        payload: {
          orderId: order().id,
          buyerId,
          total: 500_000,
          currency: 'MAD',
          shopIds: [shopA, shopB],
        },
      },
    ]);
  });

  it('refunds a payment that arrives after the cancellation', () => {
    const decision = onPaymentSucceeded(awaitingPayment({ status: 'CANCELLED' }), paid);
    expect(decision.status).toBeUndefined();
    expect(types(decision)).toEqual(['payments.refund-payment']);
  });

  it('refuses an amount that differs from the order total', () => {
    expect(() => onPaymentSucceeded(awaitingPayment(), { ...paid, amount: 499_999 })).toThrow(
      /expected 500000/,
    );
  });

  it('ignores a second success, and is out of sequence before the reservation', () => {
    expect(onPaymentSucceeded(confirmed(), paid)).toEqual({ messages: [] });
    expect(() => onPaymentSucceeded(order(), paid)).toThrow(PermanentError);
  });
});

describe('payment failed', () => {
  it('cancels the order and releases the stock', () => {
    const decision = onPaymentFailed(awaitingPayment());

    expect(decision).toMatchObject({ status: 'CANCELLED', cancellationReason: 'PAYMENT_FAILED' });
    expect(types(decision)).toEqual(['catalog.release-stock', 'orders.order-cancelled']);
  });

  it('changes nothing on a cancelled order, and is out of sequence once paid', () => {
    expect(onPaymentFailed(awaitingPayment({ status: 'CANCELLED' }))).toEqual({ messages: [] });
    expect(() => onPaymentFailed(confirmed())).toThrow(PermanentError);
  });
});

describe('payment deadline', () => {
  it('cancels an unpaid order after its deadline, releasing the stock and the payment', () => {
    const late = new Date('2026-10-21T08:15:01Z');
    const decision = expire(awaitingPayment(), late);

    expect(decision).toMatchObject({ status: 'CANCELLED', cancellationReason: 'PAYMENT_EXPIRED' });
    expect(types(decision)).toEqual([
      'catalog.release-stock',
      'payments.cancel-payment',
      'orders.order-cancelled',
    ]);
  });

  it('leaves alone an order still within its window, or already paid', () => {
    expect(expire(awaitingPayment(), new Date('2026-10-21T08:14:59Z'))).toEqual({ messages: [] });
    expect(expire(confirmed(), new Date('2026-10-21T09:00:00Z'))).toEqual({ messages: [] });
  });
});

describe('cancellation by the buyer', () => {
  it('cancels a pending order, the reservation answer will release the stock', () => {
    const decision = cancelByBuyer(order());
    expect(decision).toMatchObject({ status: 'CANCELLED', cancellationReason: 'BUYER_CANCELLED' });
    expect(decision !== 'not-cancellable' && types(decision)).toEqual(['orders.order-cancelled']);
  });

  it('cancels an order awaiting payment, releasing the stock and the payment', () => {
    const decision = cancelByBuyer(awaitingPayment());
    expect(decision !== 'not-cancellable' && types(decision)).toEqual([
      'catalog.release-stock',
      'payments.cancel-payment',
      'orders.order-cancelled',
    ]);
  });

  it('refuses once the order is paid', () => {
    expect(cancelByBuyer(confirmed())).toBe('not-cancellable');
  });
});

describe('shipments (US-10)', () => {
  it('ships with a tracking number, then delivers; the order is fulfilled when every shop delivered', () => {
    const shipped = updateShipment(
      confirmed(),
      shopA,
      { status: 'SHIPPED', trackingNumber: 'MA123' },
      now,
    );
    if (typeof shipped === 'string') throw new Error(shipped);
    expect(shipped.status).toBeUndefined();
    expect(shipped.messages).toEqual([
      {
        type: 'orders.shipment-updated',
        payload: {
          orderId: order().id,
          buyerId,
          shopId: shopA,
          status: 'SHIPPED',
          trackingNumber: 'MA123',
        },
      },
    ]);

    const almost = confirmed({
      shipments: [
        {
          shopId: shopA,
          status: 'DELIVERED',
          trackingNumber: 'MA1',
          shippedAt: now,
          deliveredAt: now,
        },
        {
          shopId: shopB,
          status: 'SHIPPED',
          trackingNumber: 'MA2',
          shippedAt: now,
          deliveredAt: null,
        },
      ],
    });
    const delivered = updateShipment(almost, shopB, { status: 'DELIVERED' }, now);
    if (typeof delivered === 'string') throw new Error(delivered);
    expect(delivered.status).toBe('FULFILLED');
    expect(delivered.shipments?.find((entry) => entry.shopId === shopB)).toMatchObject({
      status: 'DELIVERED',
      trackingNumber: 'MA2',
      deliveredAt: now,
    });
  });

  it('explains every refusal', () => {
    const otherShop = '0199f0a4-7a5b-7c1e-9f00-0000000000c9';
    expect(
      updateShipment(confirmed(), otherShop, { status: 'SHIPPED', trackingNumber: 'X1234' }, now),
    ).toBe('not-found');
    expect(updateShipment(confirmed(), shopA, { status: 'SHIPPED' }, now)).toBe(
      'tracking-required',
    );
    expect(updateShipment(confirmed(), shopA, { status: 'DELIVERED' }, now)).toBe(
      'invalid-transition',
    );
    expect(
      updateShipment(
        confirmed({ status: 'FULFILLED' }),
        shopA,
        { status: 'SHIPPED', trackingNumber: 'X1234' },
        now,
      ),
    ).toBe('not-paid');
  });
});
