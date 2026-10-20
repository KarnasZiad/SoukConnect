import { setTimeout as sleep } from 'node:timers/promises';
import type { Envelope } from '@soukconnect/contracts';
import type { Logger } from './logger.js';

/**
 * Where a service keeps the messages written in the same transaction as its state changes
 * (PostgreSQL table or MongoDB collection, see ./postgres and ./mongo).
 */
export interface OutboxStore {
  /**
   * Hands up to `limit` pending messages to `send`, oldest first, then marks them published and
   * returns how many there were. If `send` rejects, they stay pending for the next call. Several
   * relays may drain the same store: a message is handed to one of them at a time.
   */
  drain(limit: number, send: (envelopes: Envelope[]) => Promise<void>): Promise<number>;
}

export interface RelayOptions {
  store: OutboxStore;
  send: (envelopes: Envelope[]) => Promise<void>;
  logger: Logger;
  batchSize?: number;
  /** Pause when the outbox is empty; `notify()` cuts it short after a local write. */
  idleDelayMs?: number;
  /** Longest pause after repeated failures (store or broker unavailable). */
  maxBackoffMs?: number;
}

export interface Relay {
  /** Wakes the relay up: call it after committing a transaction that wrote to the outbox. */
  notify(): void;
  stop(): Promise<void>;
}

/** Publishes the outbox continuously, in batches, until stopped. */
export function startRelay(options: RelayOptions): Relay {
  const batchSize = options.batchSize ?? 100;
  const idleDelayMs = options.idleDelayMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 10_000;
  let running = true;
  let wake = new AbortController();

  async function pause(ms: number): Promise<void> {
    try {
      await sleep(ms, undefined, { signal: wake.signal });
    } catch {
      // Woken up by notify() or stop().
    }
    if (wake.signal.aborted) wake = new AbortController();
  }

  async function loop(): Promise<void> {
    let failures = 0;
    while (running) {
      try {
        const count = await options.store.drain(batchSize, options.send);
        failures = 0;
        // A full batch means there may be more: keep going without waiting.
        if (count < batchSize) await pause(idleDelayMs);
      } catch (error) {
        failures += 1;
        const backoff = Math.min(idleDelayMs * 2 ** failures, maxBackoffMs);
        options.logger.error({ err: error, failures, backoffMs: backoff }, 'outbox relay failed');
        await pause(backoff);
      }
    }
  }

  const done = loop();

  return {
    notify() {
      wake.abort();
    },
    async stop() {
      running = false;
      wake.abort();
      await done;
    },
  };
}
