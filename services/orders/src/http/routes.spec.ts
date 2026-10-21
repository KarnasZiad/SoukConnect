import type { Actor } from '@soukconnect/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  address,
  buyerId,
  lines,
  otherBuyerId,
  potId,
  rugId,
  shopA,
  shopB,
} from '../../test/fixtures.js';
import { testApp } from '../../test/memory-store.js';
import { onPaymentSucceeded, onStockReserved } from '../domain/saga.js';
import { MAX_ACTIVE_ORDERS } from '../postgres/order-store.js';

const buyer: Actor = { userId: buyerId, role: 'buyer', shopId: null };
const otherBuyer: Actor = { userId: otherBuyerId, role: 'buyer', shopId: null };
const sellerA: Actor = { userId: shopA, role: 'seller', shopId: shopA };
const sellerB: Actor = { userId: shopB, role: 'seller', shopId: shopB };

const body = {
  items: [
    { productId: rugId, quantity: 1 },
    { productId: potId, quantity: 2 },
  ],
  shippingAddress: address,
};

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
});

async function setup(now?: () => Date) {
  const context = await testApp(now);
  close = () => context.app.close();
  const place = (key = 'order-key-0001', payload: unknown = body, actor = buyer) =>
    context.call(actor, 'POST', '/orders', payload, { 'idempotency-key': key });
  return { ...context, place };
}

/** Moves an order to CONFIRMED, as the saga would. */
async function pay(store: Awaited<ReturnType<typeof setup>>['store'], orderId: string) {
  const order = store.orders.get(orderId);
  if (!order) throw new Error('no order');
  const message = (type: string) => ({
    id: crypto.randomUUID(),
    type,
    correlationId: orderId,
    causationId: null,
    occurredAt: '',
  });
  await store.handle(
    { ...message('catalog.stock-reserved'), payload: { orderId, currency: 'MAD', lines } } as never,
    (current, now) => onStockReserved(current, { orderId, currency: 'MAD', lines }, now),
  );
  await store.handle(
    { ...message('payments.payment-succeeded'), payload: { orderId } } as never,
    (current) =>
      onPaymentSucceeded(current, {
        orderId,
        paymentId: orderId,
        amount: 500_000,
        currency: 'MAD',
      }),
  );
}

describe('placing an order (US-05)', () => {
  it('accepts identifiers and quantities, and starts the reservation', async () => {
    const { place, store } = await setup();

    const response = await place();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'PENDING', total: null, items: body.items });
    expect(store.sent).toEqual([
      {
        type: 'catalog.reserve-stock',
        payload: { orderId: response.json<{ id: string }>().id, items: body.items },
      },
    ]);
  });

  it('returns the same order for a replayed request, and refuses the key for another one', async () => {
    const { place, store } = await setup();

    const first = await place();
    const replay = await place();
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(store.orders.size).toBe(1);

    const other = await place('order-key-0001', {
      ...body,
      items: [{ productId: rugId, quantity: 2 }],
    });
    expect(other.statusCode).toBe(422);
  });

  it('never takes a price, and needs an idempotency key', async () => {
    const { place, call } = await setup();

    expect(
      (
        await place('order-key-0002', {
          ...body,
          items: [{ productId: rugId, quantity: 1, unitPrice: 1 }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await place('order-key-0003', { ...body, total: 1 })).statusCode).toBe(400);
    expect(
      (await place('order-key-0004', { ...body, items: [{ productId: rugId, quantity: 100 }] }))
        .statusCode,
    ).toBe(400);
    expect((await place('short')).statusCode).toBe(400);
    expect((await call(buyer, 'POST', '/orders', body)).statusCode).toBe(400);
  });

  it('bounds the orders awaiting payment of one buyer (D2)', async () => {
    const { place } = await setup();
    for (let index = 0; index < MAX_ACTIVE_ORDERS; index += 1) {
      expect((await place(`order-key-10${String(index).padStart(2, '0')}`)).statusCode).toBe(202);
    }
    expect((await place('order-key-1099')).statusCode).toBe(429);
  });

  it('is for buyers only', async () => {
    const { place } = await setup();
    expect((await place('order-key-0005', body, sellerA)).statusCode).toBe(403);
    expect(
      (await place('order-key-0006', body, { userId: null, role: 'visitor', shopId: null }))
        .statusCode,
    ).toBe(401);
  });
});

describe('following an order (US-07)', () => {
  it('shows the order to its buyer only, without commission rates', async () => {
    const { place, call, store } = await setup();
    const { id } = (await place()).json<{ id: string }>();
    await pay(store, id);

    const mine = await call(buyer, 'GET', `/orders/${id}`);
    expect(mine.json()).toMatchObject({ status: 'CONFIRMED', total: 500_000 });
    expect(JSON.stringify(mine.json())).not.toContain('commissionBps');
    expect((await call(otherBuyer, 'GET', `/orders/${id}`)).statusCode).toBe(404);
    expect((await call(buyer, 'GET', '/orders')).json()).toMatchObject({ total: 1 });
    expect((await call(otherBuyer, 'GET', '/orders')).json()).toMatchObject({ total: 0 });
  });

  it('lets the buyer cancel before payment, not after', async () => {
    const { place, call, store } = await setup();
    const pending = (await place('order-key-0007')).json<{ id: string }>();
    const paid = (await place('order-key-0008')).json<{ id: string }>();
    await pay(store, paid.id);

    expect((await call(buyer, 'POST', `/orders/${pending.id}/cancel`)).json()).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'BUYER_CANCELLED',
    });
    expect((await call(buyer, 'POST', `/orders/${paid.id}/cancel`)).statusCode).toBe(409);
    expect((await call(otherBuyer, 'POST', `/orders/${paid.id}/cancel`)).statusCode).toBe(404);
  });
});

describe('seller space (US-10, US-11)', () => {
  it('shows each seller its own lines of paid orders, with the address to ship to', async () => {
    const { place, call, store } = await setup();
    const { id } = (await place()).json<{ id: string }>();
    expect((await call(sellerA, 'GET', '/seller/orders')).json()).toMatchObject({ total: 0 });
    await pay(store, id);

    const response = await call(sellerA, 'GET', '/seller/orders');
    expect(response.json()).toMatchObject({
      total: 1,
      items: [
        {
          orderId: id,
          subtotal: 450_000,
          shipment: { shopId: shopA, status: 'PREPARING' },
          shippingAddress: address,
        },
      ],
    });
    const [order] = response.json<{ items: { lines: { shopId: string }[] }[] }>().items;
    expect(order?.lines.map((line) => line.shopId)).toEqual([shopA]);
  });

  it('ships with a tracking number, then delivers', async () => {
    const { place, call, store } = await setup();
    const { id } = (await place()).json<{ id: string }>();
    await pay(store, id);

    const noTracking = await call(sellerA, 'POST', `/seller/orders/${id}/shipment`, {
      status: 'SHIPPED',
    });
    expect(noTracking.statusCode).toBe(409);
    expect(noTracking.json()).toMatchObject({ reason: 'tracking-required' });

    const shipped = await call(sellerA, 'POST', `/seller/orders/${id}/shipment`, {
      status: 'SHIPPED',
      trackingNumber: 'MA123456789',
    });
    expect(shipped.json()).toMatchObject({
      shipment: { status: 'SHIPPED', trackingNumber: 'MA123456789' },
    });
    expect(store.sent.at(-1)).toMatchObject({ type: 'orders.shipment-updated' });

    const delivered = await call(sellerA, 'POST', `/seller/orders/${id}/shipment`, {
      status: 'DELIVERED',
    });
    expect(delivered.json()).toMatchObject({ shipment: { status: 'DELIVERED' } });
  });

  it('keeps a seller out of the orders of other shops (I1)', async () => {
    const { place, call, store } = await setup();
    const { id } = (await place()).json<{ id: string }>();
    await pay(store, id);
    const outsider: Actor = { userId: otherBuyerId, role: 'seller', shopId: otherBuyerId };

    expect(
      (
        await call(outsider, 'POST', `/seller/orders/${id}/shipment`, {
          status: 'SHIPPED',
          trackingNumber: 'MA1234',
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(buyer, 'GET', '/seller/orders')).statusCode).toBe(403);
    expect((await call(sellerB, 'GET', '/seller/orders')).json()).toMatchObject({ total: 1 });
  });

  it('computes statistics over the chosen period', async () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const { call, store } = await setup(() => now);

    const stats = await call(sellerA, 'GET', '/seller/stats?days=7');
    expect(stats.json()).toMatchObject({ days: 7, revenue: 900_000, net: 810_000 });
    expect(store.statsSince).toEqual(new Date('2026-10-14T12:00:00Z'));
    expect((await call(sellerA, 'GET', '/seller/stats?days=365')).statusCode).toBe(400);
  });
});
