import { createEnvelope, type Envelope } from '@soukconnect/contracts';
import { describe, expect, it, vi } from 'vitest';
import { settle, silentLogger } from '../test/fake-channel.js';
import { type OutboxStore, startRelay } from './outbox.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';
const message = () =>
  createEnvelope('catalog.commit-stock', { orderId }, { correlationId: orderId });

/** An outbox in memory: messages leave it only when `send` resolved. */
class MemoryOutbox implements OutboxStore {
  pending: Envelope[] = [];
  failures = 0;
  drainCalls = 0;

  async drain(limit: number, send: (envelopes: Envelope[]) => Promise<void>): Promise<number> {
    this.drainCalls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('database unavailable');
    }
    const batch = this.pending.slice(0, limit);
    if (batch.length === 0) return 0;
    await send(batch);
    this.pending = this.pending.slice(batch.length);
    return batch.length;
  }
}

describe('startRelay', () => {
  it('publishes pending messages in batches until the outbox is empty', async () => {
    const store = new MemoryOutbox();
    store.pending = Array.from({ length: 5 }, message);
    const sent: Envelope[][] = [];
    const relay = startRelay({
      store,
      send: (envelopes) => {
        sent.push(envelopes);
        return Promise.resolve();
      },
      logger: silentLogger(),
      batchSize: 2,
      idleDelayMs: 10_000,
    });

    await vi.waitFor(() => {
      expect(store.pending).toHaveLength(0);
    });
    expect(sent.map((batch) => batch.length)).toEqual([2, 2, 1]);
    await relay.stop();
  });

  it('keeps messages pending when sending fails, and retries them', async () => {
    const store = new MemoryOutbox();
    store.pending = [message()];
    const send = vi
      .fn<(envelopes: Envelope[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValue();
    const logger = silentLogger();
    const relay = startRelay({ store, send, logger, idleDelayMs: 1, maxBackoffMs: 5 });

    await vi.waitFor(() => {
      expect(store.pending).toHaveLength(0);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.entries).toContainEqual({ level: 'error', message: 'outbox relay failed' });
    await relay.stop();
  });

  it('backs off while the store is unavailable', async () => {
    const store = new MemoryOutbox();
    store.failures = 2;
    store.pending = [message()];
    const relay = startRelay({
      store,
      send: () => Promise.resolve(),
      logger: silentLogger(),
      idleDelayMs: 1,
      maxBackoffMs: 4,
    });

    await vi.waitFor(() => {
      expect(store.pending).toHaveLength(0);
    });
    expect(store.drainCalls).toBeGreaterThanOrEqual(3);
    await relay.stop();
  });

  it('wakes up at once when notified after a write', async () => {
    const store = new MemoryOutbox();
    const relay = startRelay({
      store,
      send: () => Promise.resolve(),
      logger: silentLogger(),
      idleDelayMs: 60_000,
    });
    await settle();
    expect(store.drainCalls).toBe(1);

    store.pending = [message()];
    relay.notify();
    await vi.waitFor(() => {
      expect(store.pending).toHaveLength(0);
    });
    await relay.stop();
  });

  it('stops promptly even during a long pause', async () => {
    const relay = startRelay({
      store: new MemoryOutbox(),
      send: () => Promise.resolve(),
      logger: silentLogger(),
      idleDelayMs: 60_000,
    });
    await settle();

    const started = Date.now();
    await relay.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
