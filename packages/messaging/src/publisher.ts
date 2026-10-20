import { once } from 'node:events';
import type { Envelope } from '@soukconnect/contracts';
import type { ConfirmChannel } from 'amqplib';
import { toWire } from './codec.js';
import { EXCHANGE } from './topology.js';

/**
 * Publishes messages to the exchange and resolves once the broker has confirmed every one of them
 * (written to disk for durable queues). Rejects if any is refused: the caller keeps them pending.
 */
export async function publish(
  channel: ConfirmChannel,
  envelopes: readonly Envelope[],
): Promise<void> {
  for (const envelope of envelopes) {
    const wire = toWire(envelope);
    // false: the channel buffer is full; wait until it drains rather than piling up in memory.
    if (!channel.publish(EXCHANGE, wire.routingKey, wire.content, wire.options)) {
      await once(channel, 'drain');
    }
  }
  await channel.waitForConfirms();
}
