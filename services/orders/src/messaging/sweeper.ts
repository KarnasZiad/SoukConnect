import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '@soukconnect/service-kit';
import type { OrderStore } from '../ports.js';

export interface Sweeper {
  stop(): Promise<void>;
}

/**
 * Cancels the orders whose payment deadline passed, in batches, every `intervalMs`. The deadline
 * lives in the database, so a restart or several replicas never lose or double an expiry.
 */
export function startSweeper(options: {
  store: Pick<OrderStore, 'expireDue'>;
  logger: Logger;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
}): Sweeper {
  const intervalMs = options.intervalMs ?? 30_000;
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? (() => new Date());
  const stopping = new AbortController();

  async function loop(): Promise<void> {
    while (!stopping.signal.aborted) {
      try {
        let expired: number;
        do {
          expired = await options.store.expireDue(now(), batchSize);
          if (expired > 0) options.logger.info({ expired }, 'unpaid orders cancelled');
        } while (expired === batchSize);
      } catch (error) {
        options.logger.error({ err: error }, 'expiry sweep failed');
      }
      try {
        await sleep(intervalMs, undefined, { signal: stopping.signal });
      } catch {
        // Stopped.
      }
    }
  }

  const done = loop();
  return {
    async stop() {
      stopping.abort();
      await done;
    },
  };
}
