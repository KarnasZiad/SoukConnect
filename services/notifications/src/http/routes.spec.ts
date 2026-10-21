import { afterEach, describe, expect, it } from 'vitest';
import {
  buyer,
  buyerId,
  otherBuyer,
  otherSeller,
  seller,
  sellerId,
  testApp,
} from '../../test/fakes.js';
import { MESSAGES_PER_MINUTE } from '../domain/model.js';

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
});

async function setup() {
  const context = await testApp();
  close = () => context.app.close();
  const open = await context.call(buyer, 'POST', '/conversations', { shopId: sellerId });
  return { ...context, conversationId: open.json<{ id: string }>().id };
}

describe('contacts', () => {
  it('keeps and erases the contact of the caller only', async () => {
    const { call, store } = await setup();

    expect(
      (
        await call(buyer, 'PUT', '/contacts/me', {
          email: 'amina@example.ma',
          displayName: 'Amina',
          locale: 'ar',
        })
      ).statusCode,
    ).toBe(204);
    expect(store.contacts.get(buyerId)).toMatchObject({ email: 'amina@example.ma', locale: 'ar' });
    expect(
      (
        await call(buyer, 'PUT', '/contacts/me', {
          email: 'not-an-email',
          displayName: 'A',
          locale: 'fr',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call({ userId: null, role: 'visitor', shopId: null }, 'DELETE', '/contacts/me'))
        .statusCode,
    ).toBe(401);

    await call(buyer, 'DELETE', '/contacts/me');
    expect(store.contacts.size).toBe(0);
  });
});

describe('conversations (US-12)', () => {
  it('opens one conversation per buyer and shop, for buyers only', async () => {
    const { call, conversationId } = await setup();

    const again = await call(buyer, 'POST', '/conversations', {
      shopId: sellerId,
      productId: sellerId,
    });
    expect(again.json<{ id: string }>().id).toBe(conversationId);
    expect((await call(seller, 'POST', '/conversations', { shopId: sellerId })).statusCode).toBe(
      403,
    );
  });

  it('delivers a message to both sides, live, and counts it unread for the other', async () => {
    const { call, push, conversationId } = await setup();

    const sent = await call(buyer, 'POST', `/conversations/${conversationId}/messages`, {
      body: '  Bonjour, le tapis existe-t-il en 150 × 200 ?  ',
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      authorId: buyerId,
      body: 'Bonjour, le tapis existe-t-il en 150 × 200 ?',
    });
    expect(push.pushed.map((entry) => entry.userId)).toEqual([sellerId, buyerId]);

    const inbox = await call(seller, 'GET', '/conversations');
    expect(inbox.json()).toMatchObject({ items: [{ id: conversationId, unread: 1 }] });
    await call(seller, 'POST', `/conversations/${conversationId}/read`);
    expect((await call(seller, 'GET', '/conversations')).json()).toMatchObject({
      items: [{ unread: 0 }],
    });

    await call(seller, 'POST', `/conversations/${conversationId}/messages`, {
      body: 'Oui, sur commande.',
    });
    const thread = await call(buyer, 'GET', `/conversations/${conversationId}/messages?limit=10`);
    expect(
      thread.json<{ items: { body: string }[] }>().items.map((message) => message.body),
    ).toEqual(['Bonjour, le tapis existe-t-il en 150 × 200 ?', 'Oui, sur commande.']);
    expect((await call(buyer, 'GET', '/conversations')).json()).toMatchObject({
      items: [{ unread: 1 }],
    });
  });

  it('answers 404 to anyone outside the conversation (I1)', async () => {
    const { call, conversationId } = await setup();

    for (const actor of [otherBuyer, otherSeller]) {
      expect(
        (await call(actor, 'GET', `/conversations/${conversationId}/messages`)).statusCode,
      ).toBe(404);
      expect(
        (await call(actor, 'POST', `/conversations/${conversationId}/messages`, { body: 'hi' }))
          .statusCode,
      ).toBe(404);
      expect((await call(actor, 'POST', `/conversations/${conversationId}/read`)).statusCode).toBe(
        404,
      );
    }
    expect((await call(otherSeller, 'GET', '/conversations')).json()).toEqual({ items: [] });
  });

  it('bounds the length of a message and the pace of an author', async () => {
    const { call, conversationId } = await setup();

    expect(
      (
        await call(buyer, 'POST', `/conversations/${conversationId}/messages`, {
          body: 'x'.repeat(2001),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call(buyer, 'POST', `/conversations/${conversationId}/messages`, { body: '   ' }))
        .statusCode,
    ).toBe(400);
    for (let index = 0; index < MESSAGES_PER_MINUTE; index += 1) {
      await call(buyer, 'POST', `/conversations/${conversationId}/messages`, {
        body: `message ${index}`,
      });
    }
    const flooded = await call(buyer, 'POST', `/conversations/${conversationId}/messages`, {
      body: 'one more',
    });
    expect(flooded.statusCode).toBe(429);
    expect(flooded.headers['retry-after']).toBe('60');
    // The other side can still answer.
    expect(
      (await call(seller, 'POST', `/conversations/${conversationId}/messages`, { body: 'ok' }))
        .statusCode,
    ).toBe(201);
  });
});

describe('notifications (US-07)', () => {
  it('lists the notifications of the caller and marks them read', async () => {
    const { call, store } = await setup();
    const planned = { type: 'order-shipped' as const, orderId: sellerId, data: {}, email: false };
    await store.recordNotification('event-1', { ...planned, userId: buyerId });
    await store.recordNotification('event-2', { ...planned, userId: buyerId });
    await store.recordNotification('event-1', { ...planned, userId: sellerId });

    expect(
      (await call(buyer, 'GET', '/notifications')).json<{ items: unknown[] }>().items,
    ).toHaveLength(2);
    expect(
      (
        await call(buyer, 'POST', '/notifications/read', {
          ids: [`event-1:${buyerId}`, `event-1:${sellerId}`],
        })
      ).json(),
    ).toEqual({ read: 1 });
    expect(
      (await call(buyer, 'GET', '/notifications?unread=true')).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
    expect((await call(buyer, 'POST', '/notifications/read', { ids: 'all' })).json()).toEqual({
      read: 1,
    });
    expect(
      (await call(seller, 'GET', '/notifications?unread=true')).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
  });
});
