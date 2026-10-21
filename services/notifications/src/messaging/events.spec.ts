import { createEnvelope } from '@soukconnect/contracts';
import { createLogger } from '@soukconnect/service-kit';
import { describe, expect, it } from 'vitest';
import { buyerId, FakeMailer, FakePush, MemoryStore, orderId, sellerId } from '../../test/fakes.js';
import { eventHandlers } from './events.js';

const context = { attempt: 0, redelivered: false };
const confirmed = createEnvelope(
  'orders.order-confirmed',
  { orderId, buyerId, total: 500_000, currency: 'MAD', shopIds: [sellerId] },
  { correlationId: orderId },
);

function setup() {
  const store = new MemoryStore();
  const push = new FakePush();
  const mailer = new FakeMailer();
  const handlers = eventHandlers({
    store,
    push,
    mailer,
    publicUrl: 'https://soukconnect.ma',
    logger: createLogger('notifications-test', 'silent'),
  });
  return { store, push, mailer, handle: handlers['orders.order-confirmed'] };
}

describe('order events', () => {
  it('records, pushes and e-mails the notifications of a confirmed order', async () => {
    const { store, push, mailer, handle } = setup();
    await store.saveContact({
      userId: buyerId,
      email: 'amina@example.ma',
      displayName: 'Amina',
      locale: 'ar',
    });
    await store.saveContact({
      userId: sellerId,
      email: 'fatima@example.ma',
      displayName: 'Fatima',
      locale: 'fr',
    });

    await handle?.(confirmed, context);

    expect(push.pushed.map((entry) => [entry.userId, entry.event])).toEqual([
      [buyerId, 'notification'],
      [sellerId, 'notification'],
    ]);
    expect(mailer.sent.map((entry) => entry.to)).toEqual(['amina@example.ma', 'fatima@example.ma']);
    expect(mailer.sent[1]?.email.subject).toContain('Nouvelle commande');
  });

  it('pushes and e-mails once when the event is delivered again', async () => {
    const { store, push, mailer, handle } = setup();
    await store.saveContact({
      userId: buyerId,
      email: 'amina@example.ma',
      displayName: 'Amina',
      locale: 'fr',
    });

    await handle?.(confirmed, context);
    await handle?.(confirmed, { attempt: 0, redelivered: true });

    expect(push.pushed).toHaveLength(2);
    expect(mailer.sent).toHaveLength(1);
    expect(store.notifications.size).toBe(2);
  });

  it('sends the e-mail still owed when the previous attempt failed', async () => {
    const { store, push, mailer, handle } = setup();
    await store.saveContact({
      userId: buyerId,
      email: 'amina@example.ma',
      displayName: 'Amina',
      locale: 'en',
    });
    mailer.failures = 1;

    await expect(handle?.(confirmed, context)).rejects.toThrow('SMTP unavailable');
    await handle?.(confirmed, { attempt: 1, redelivered: false });

    expect(mailer.sent.map((entry) => entry.email.subject)).toEqual([
      `Order ${orderId.slice(0, 8).toUpperCase()} confirmed`,
    ]);
    // Each notification is pushed once over both attempts.
    expect(push.pushed).toHaveLength(2);
  });

  it('notifies without e-mail a person whose contact is unknown', async () => {
    const { push, mailer, handle } = setup();
    await handle?.(confirmed, context);

    expect(push.pushed).toHaveLength(2);
    expect(mailer.sent).toEqual([]);
  });
});

describe('shipment events', () => {
  it('e-mails the tracking number of a shipped parcel', async () => {
    const { store, mailer } = setup();
    const push = new FakePush();
    await store.saveContact({
      userId: buyerId,
      email: 'amina@example.ma',
      displayName: 'Amina',
      locale: 'fr',
    });
    const handlers = eventHandlers({
      store,
      push,
      mailer,
      publicUrl: 'https://soukconnect.ma',
      logger: createLogger('notifications-test', 'silent'),
    });

    await handlers['orders.shipment-updated']?.(
      createEnvelope(
        'orders.shipment-updated',
        { orderId, buyerId, shopId: sellerId, status: 'SHIPPED', trackingNumber: 'MA123456' },
        { correlationId: orderId },
      ),
      context,
    );

    expect(mailer.sent[0]?.email.text).toContain('MA123456');
    expect(push.pushed).toMatchObject([{ userId: buyerId, payload: { type: 'order-shipped' } }]);
  });
});
