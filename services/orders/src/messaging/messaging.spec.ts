import { createEnvelope } from '@soukconnect/contracts';
import { createLogger } from '@soukconnect/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { lines, order } from '../../test/fixtures.js';
import { MemoryOrderStore } from '../../test/memory-store.js';
import { sagaHandlers } from './saga.js';
import { startSweeper } from './sweeper.js';

const context = { attempt: 0, redelivered: false };

describe('saga handlers', () => {
  it('drive an order from reservation to confirmation', async () => {
    const store = new MemoryOrderStore();
    const placed = order();
    store.orders.set(placed.id, { ...placed, key: 'k', hash: 'h' });
    const handlers = sagaHandlers(store);

    await handlers['catalog.stock-reserved']?.(
      createEnvelope(
        'catalog.stock-reserved',
        { orderId: placed.id, currency: 'MAD', lines },
        { correlationId: placed.id },
      ),
      context,
    );
    expect(store.orders.get(placed.id)?.status).toBe('AWAITING_PAYMENT');

    await handlers['payments.payment-succeeded']?.(
      createEnvelope(
        'payments.payment-succeeded',
        { orderId: placed.id, paymentId: placed.id, amount: 500_000, currency: 'MAD' },
        { correlationId: placed.id },
      ),
      context,
    );
    expect(store.orders.get(placed.id)?.status).toBe('CONFIRMED');
    expect(store.sent.map((message) => message.type)).toEqual([
      'payments.request-payment',
      'catalog.commit-stock',
      'orders.order-confirmed',
    ]);
  });

  it('reject an order, or cancel it when its payment fails', async () => {
    const store = new MemoryOrderStore();
    const rejected = order({ id: '0199f0a4-7a5b-7c1e-9f00-0000000000f1' });
    const failing = order({
      id: '0199f0a4-7a5b-7c1e-9f00-0000000000f2',
      status: 'AWAITING_PAYMENT',
      lines,
      total: 500_000,
    });
    for (const entry of [rejected, failing])
      store.orders.set(entry.id, { ...entry, key: entry.id, hash: 'h' });
    const handlers = sagaHandlers(store);

    await handlers['catalog.stock-rejected']?.(
      createEnvelope(
        'catalog.stock-rejected',
        {
          orderId: rejected.id,
          unavailable: [{ productId: lines[0]?.productId ?? '', requested: 1, available: 0 }],
        },
        { correlationId: rejected.id },
      ),
      context,
    );
    await handlers['payments.payment-failed']?.(
      createEnvelope(
        'payments.payment-failed',
        { orderId: failing.id, paymentId: failing.id, reason: 'canceled' },
        { correlationId: failing.id },
      ),
      context,
    );

    expect(store.orders.get(rejected.id)?.status).toBe('REJECTED');
    expect(store.orders.get(failing.id)?.status).toBe('CANCELLED');
  });
});

describe('expiry sweeper', () => {
  const logger = createLogger('orders-test', 'silent');

  it('sweeps in batches until nothing is due, then waits for the next round', async () => {
    const expireDue = vi
      .fn<(now: Date, limit: number) => Promise<number>>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    const sweeper = startSweeper({
      store: { expireDue },
      logger,
      batchSize: 2,
      intervalMs: 60_000,
    });

    await vi.waitFor(() => {
      expect(expireDue).toHaveBeenCalledTimes(3);
    });
    await sweeper.stop();
    expect(expireDue).toHaveBeenCalledTimes(3);
  });

  it('keeps sweeping after a failure', async () => {
    const expireDue = vi
      .fn<(now: Date, limit: number) => Promise<number>>()
      .mockRejectedValueOnce(new Error('database restarting'))
      .mockResolvedValue(0);
    const sweeper = startSweeper({ store: { expireDue }, logger, intervalMs: 5 });

    await vi.waitFor(() => {
      expect(expireDue.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await sweeper.stop();
  });
});
