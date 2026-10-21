import { createEnvelope, uuidv7 } from '@soukconnect/contracts';
import { PermanentError } from '@soukconnect/messaging';
import type { Actor } from '@soukconnect/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { buyerId, requestPayment, shopA, signedEvent, testApp } from '../../test/fakes.js';
import { commandHandlers } from '../messaging/commands.js';

const buyer: Actor = { userId: buyerId, role: 'buyer', shopId: null };
const seller: Actor = { userId: shopA, role: 'seller', shopId: shopA };
const context = { attempt: 0, redelivered: false };

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
});

/** A payment requested by orders, with its intent at the fake Stripe. */
async function setup() {
  const context_ = await testApp();
  close = () => context_.app.close();
  const handlers = commandHandlers(context_.store, context_.gateway);
  const command = requestPayment();
  await handlers['payments.request-payment']?.(command, context);
  const payment = await context_.store.findByOrder(command.payload.orderId);
  if (!payment) throw new Error('no payment');
  return { ...context_, handlers, command, payment };
}

describe('payment commands', () => {
  it('creates one intent per order, even when the command is delivered again', async () => {
    const { handlers, command, gateway, store, payment } = await setup();

    await handlers['payments.request-payment']?.(command, context);
    await handlers['payments.request-payment']?.({ ...command, id: uuidv7() }, context);

    expect(gateway.intents.size).toBe(1);
    expect(store.payments.size).toBe(1);
    expect(payment).toMatchObject({ status: 'REQUIRES_PAYMENT', amount: 500_000 });
  });

  it('refuses shares that do not add up, and a second payment of another amount', async () => {
    const { handlers, command } = await setup();
    const forged = requestPayment(undefined, 500_000);
    forged.payload.shares[0] = { shopId: shopA, amount: 1, commissionBps: 0 };

    await expect(handlers['payments.request-payment']?.(forged, context)).rejects.toThrow(
      PermanentError,
    );
    await expect(
      handlers['payments.request-payment']?.(
        { ...requestPayment(command.payload.orderId, 600_000) },
        context,
      ),
    ).rejects.toThrow(/another amount/);
  });

  it('cancels an unpaid intent, and refunds a paid one', async () => {
    const { handlers, gateway, payment, store, webhook } = await setup();
    const orderId = payment.orderId;

    await handlers['payments.cancel-payment']?.(
      createEnvelope(
        'payments.cancel-payment',
        { orderId, reason: 'expired' },
        { correlationId: orderId },
      ),
      context,
    );
    expect(gateway.cancelled).toEqual([payment.intentId]);

    gateway.pay(payment.intentId);
    await webhook(
      signedEvent('payment_intent.succeeded', { object: 'payment_intent', id: payment.intentId }),
    );
    await handlers['payments.refund-payment']?.(
      createEnvelope(
        'payments.refund-payment',
        { orderId, reason: 'late' },
        { correlationId: orderId },
      ),
      context,
    );
    expect(gateway.refunds).toEqual([payment.intentId]);
    expect(store.handled.size).toBe(3);

    await expect(
      handlers['payments.refund-payment']?.(
        createEnvelope(
          'payments.refund-payment',
          { orderId: uuidv7(), reason: 'x' },
          { correlationId: 'x' },
        ),
        context,
      ),
    ).rejects.toThrow(PermanentError);
  });
});

describe('Stripe webhooks (US-06)', () => {
  it('confirms a payment once, with its ledger, and tells orders', async () => {
    const { gateway, payment, store, webhook } = await setup();
    gateway.pay(payment.intentId);
    const event = signedEvent('payment_intent.succeeded', {
      object: 'payment_intent',
      id: payment.intentId,
    });

    const first = await webhook(event);
    const replay = await webhook(event);

    expect(first.json()).toEqual({ received: true, outcome: 'applied' });
    expect(replay.json()).toEqual({ received: true, outcome: 'duplicate' });
    expect((await store.findByOrder(payment.orderId))?.status).toBe('SUCCEEDED');
    expect(store.entries).toHaveLength(4);
    expect(store.sent).toEqual([
      expect.objectContaining({
        type: 'payments.payment-succeeded',
        payload: expect.objectContaining({ amount: 500_000 }),
      }),
    ]);
  });

  it('refuses unsigned, forged and stale events', async () => {
    const { payment, webhook, app } = await setup();
    const object = { object: 'payment_intent', id: payment.intentId };

    const forged = signedEvent('payment_intent.succeeded', object, { secret: 'whsec_attacker' });
    const stale = signedEvent('payment_intent.succeeded', object, {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    const tampered = {
      ...signedEvent('payment_intent.succeeded', object),
      payload: JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object } }),
    };

    for (const event of [forged, stale, tampered]) {
      const response = await webhook(event);
      expect(response.statusCode).toBe(400);
    }
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: { id: 'evt' },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('does not confirm a success that Stripe does not back with the full amount', async () => {
    const { gateway, payment, store, webhook } = await setup();
    gateway.pay(payment.intentId, 100);

    const response = await webhook(
      signedEvent('payment_intent.succeeded', { object: 'payment_intent', id: payment.intentId }),
    );

    expect(response.json()).toMatchObject({ outcome: 'ignored' });
    expect(await store.findByOrder(payment.orderId)).toMatchObject({
      status: 'REQUIRES_PAYMENT',
      lastError: 'Amount received does not match the payment',
    });
    expect(store.sent).toEqual([]);
  });

  it('reports a cancelled intent and books a refund', async () => {
    const { gateway, payment, store, webhook } = await setup();

    await webhook(
      signedEvent('payment_intent.canceled', { object: 'payment_intent', id: payment.intentId }),
    );
    expect(store.sent.map((message) => message.type)).toEqual(['payments.payment-failed']);

    const second = await setup();
    second.gateway.pay(second.payment.intentId);
    await second.webhook(
      signedEvent('payment_intent.succeeded', {
        object: 'payment_intent',
        id: second.payment.intentId,
      }),
    );
    await second.webhook(
      signedEvent('charge.refunded', {
        object: 'charge',
        id: 'ch_1',
        payment_intent: second.payment.intentId,
      }),
    );
    expect(second.store.sent.map((message) => message.type)).toEqual([
      'payments.payment-succeeded',
      'payments.payment-refunded',
    ]);
    expect(second.store.entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
    expect(gateway.refunds).toEqual([]);
  });

  it('ignores events about intents it did not create', async () => {
    const { webhook } = await setup();
    const response = await webhook(
      signedEvent('payment_intent.succeeded', { object: 'payment_intent', id: 'pi_unknown' }),
    );
    expect(response.json()).toMatchObject({ outcome: 'ignored' });
    const customer = await webhook(
      signedEvent('customer.created', { object: 'customer', id: 'cus_1' }),
    );
    expect(customer.json()).toMatchObject({ outcome: 'ignored' });
  });
});

describe('buyer and seller views', () => {
  it('gives the buyer the client secret of an unpaid intent, and nobody else', async () => {
    const { call, payment } = await setup();

    const mine = await call(buyer, 'GET', `/orders/${payment.orderId}/payment`);
    expect(mine.json()).toEqual({
      status: 'REQUIRES_PAYMENT',
      amount: 500_000,
      currency: 'MAD',
      clientSecret: `${payment.intentId}_secret_test`,
    });
    const someone = { ...buyer, userId: '0199f0a4-7a5b-7c1e-9f00-0000000000b9' };
    expect((await call(someone, 'GET', `/orders/${payment.orderId}/payment`)).statusCode).toBe(404);
    expect((await call(seller, 'GET', `/orders/${payment.orderId}/payment`)).statusCode).toBe(403);
  });

  it('hides the client secret once paid, and shows the seller its balance', async () => {
    const { call, gateway, payment, webhook } = await setup();
    gateway.pay(payment.intentId);
    await webhook(
      signedEvent('payment_intent.succeeded', { object: 'payment_intent', id: payment.intentId }),
    );

    expect((await call(buyer, 'GET', `/orders/${payment.orderId}/payment`)).json()).toMatchObject({
      status: 'SUCCEEDED',
      clientSecret: null,
    });
    expect((await call(seller, 'GET', '/seller/balance?days=7')).json()).toEqual({
      days: 7,
      sales: 450_000,
      commission: 45_000,
      refunds: 0,
      net: 405_000,
    });
    expect((await call(buyer, 'GET', '/seller/balance')).statusCode).toBe(403);
  });
});
