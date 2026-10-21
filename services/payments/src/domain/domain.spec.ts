import { PermanentError } from '@soukconnect/messaging';
import { describe, expect, it } from 'vitest';
import { shopA, shopB } from '../../test/fakes.js';
import type { Payment } from '../ports.js';
import { decide } from './events.js';
import { assertShares, balanceOf, refundEntries, saleEntries } from './ledger.js';

const shares = [
  { shopId: shopA, amount: 450_000, commissionBps: 1000 },
  { shopId: shopB, amount: 12_345, commissionBps: 1000 },
];

const payment: Payment = {
  id: '0199f0a4-7a5b-7c1e-9f00-0000000000e1',
  orderId: '0199f0a4-7a5b-7c1e-9f00-00000000000a',
  buyerId: '0199f0a4-7a5b-7c1e-9f00-0000000000b1',
  intentId: 'pi_123',
  amount: 462_345,
  currency: 'MAD',
  status: 'REQUIRES_PAYMENT',
  shares,
  lastError: null,
};

const event = (type: string) => ({ id: 'evt_1', type, intentId: 'pi_123', failureMessage: null });

describe('ledger (US-13)', () => {
  it('records a sale and a commission per shop, rounded on the share', () => {
    expect(saleEntries(shares, 462_345)).toEqual([
      { shopId: shopA, kind: 'SALE', amount: 450_000 },
      { shopId: shopA, kind: 'COMMISSION', amount: -45_000 },
      { shopId: shopB, kind: 'SALE', amount: 12_345 },
      { shopId: shopB, kind: 'COMMISSION', amount: -1235 },
    ]);
  });

  it('balances to zero after a full refund', () => {
    const entries = [...saleEntries(shares, 462_345), ...refundEntries(shares)];
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
    expect(balanceOf(entries.filter((entry) => entry.shopId === shopA))).toEqual({
      sales: 450_000,
      commission: 0,
      refunds: 450_000,
      net: 0,
    });
  });

  it('computes what a shop earned, net of the commission', () => {
    expect(
      balanceOf(saleEntries(shares, 462_345).filter((entry) => entry.shopId === shopA)),
    ).toEqual({
      sales: 450_000,
      commission: 45_000,
      refunds: 0,
      net: 405_000,
    });
  });

  it('refuses shares that do not add up to the amount, or name a shop twice', () => {
    expect(() => {
      assertShares(shares, 462_344);
    }).toThrow(PermanentError);
    expect(() => {
      assertShares(
        [
          { shopId: shopA, amount: 1, commissionBps: 0 },
          { shopId: shopA, amount: 1, commissionBps: 0 },
        ],
        2,
      );
    }).toThrow(/twice/);
  });
});

describe('Stripe events', () => {
  const received = { amountReceived: 462_345, currency: 'mad' };

  it('turns a confirmed success into ledger entries and a message for orders', () => {
    const decision = decide(payment, event('payment_intent.succeeded'), received);

    expect(decision).toMatchObject({
      kind: 'change',
      status: 'SUCCEEDED',
      message: {
        type: 'payments.payment-succeeded',
        payload: {
          orderId: payment.orderId,
          paymentId: payment.id,
          amount: 462_345,
          currency: 'MAD',
        },
      },
    });
    expect(decision.kind === 'change' && decision.entries).toHaveLength(4);
  });

  it('records a success for a cancelled payment too: orders will refund it', () => {
    expect(
      decide({ ...payment, status: 'CANCELLED' }, event('payment_intent.succeeded'), received),
    ).toMatchObject({
      kind: 'change',
      status: 'SUCCEEDED',
    });
  });

  it('does not trust a success that Stripe does not confirm with the same amount and currency', () => {
    for (const checked of [
      null,
      { ...received, amountReceived: 1 },
      { ...received, currency: 'eur' },
    ]) {
      expect(decide(payment, event('payment_intent.succeeded'), checked)).toEqual({
        kind: 'error',
        message: 'Amount received does not match the payment',
      });
    }
  });

  it('ignores a success already recorded', () => {
    expect(
      decide({ ...payment, status: 'SUCCEEDED' }, event('payment_intent.succeeded'), received),
    ).toEqual({ kind: 'ignore' });
    expect(
      decide({ ...payment, status: 'REFUNDED' }, event('payment_intent.succeeded'), received),
    ).toEqual({ kind: 'ignore' });
  });

  it('reports a cancellation, keeps a declined card as a retryable error, and books refunds', () => {
    expect(decide(payment, event('payment_intent.canceled'), null)).toMatchObject({
      kind: 'change',
      status: 'CANCELLED',
      message: { type: 'payments.payment-failed' },
    });
    expect(
      decide({ ...payment, status: 'SUCCEEDED' }, event('payment_intent.canceled'), null),
    ).toEqual({ kind: 'ignore' });
    expect(
      decide(
        payment,
        { ...event('payment_intent.payment_failed'), failureMessage: 'Your card was declined.' },
        null,
      ),
    ).toEqual({ kind: 'error', message: 'Your card was declined.' });
    expect(decide(payment, event('payment_intent.payment_failed'), null)).toMatchObject({
      kind: 'error',
    });

    const refund = decide({ ...payment, status: 'SUCCEEDED' }, event('charge.refunded'), null);
    expect(refund).toMatchObject({
      kind: 'change',
      status: 'REFUNDED',
      message: { type: 'payments.payment-refunded' },
    });
    expect(decide(payment, event('charge.refunded'), null)).toEqual({ kind: 'ignore' });
    expect(decide(payment, event('customer.created'), null)).toEqual({ kind: 'ignore' });
  });
});
