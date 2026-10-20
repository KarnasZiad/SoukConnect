import type { MessageType } from '@soukconnect/contracts';
import type { Channel } from 'amqplib';

/** The single topic exchange of the platform; the routing key is the message type. */
export const EXCHANGE = 'souk.events';

/** Delays before the 1st, 2nd and 3rd retry; after that the message is dead-lettered. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 10_000, 60_000];

export interface QueueSpec {
  /** Durable queue of one consumer service, e.g. `orders.saga`. */
  queue: string;
  /** Message types routed to this queue. */
  bindings: readonly MessageType[];
  retryDelaysMs?: readonly number[];
}

export const retryQueueOf = (queue: string, attempt: number): string => `${queue}.retry.${attempt}`;
export const deadQueueOf = (queue: string): string => `${queue}.dead`;

type TopologyChannel = Pick<Channel, 'assertExchange' | 'assertQueue' | 'bindQueue'>;

/**
 * Declares the exchange and, for each consumer, its quorum queue, one retry queue per delay and its
 * dead-letter queue. Declarations are idempotent: every service runs them at startup.
 *
 * A retry queue has a fixed TTL (one queue per delay avoids head-of-line blocking) and
 * dead-letters through the default exchange straight back to its own queue: a retried message is
 * never routed again to the other subscribers of its type.
 */
export async function declareTopology(
  channel: TopologyChannel,
  specs: readonly QueueSpec[] = [],
): Promise<void> {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  for (const spec of specs) {
    await channel.assertQueue(spec.queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    for (const type of spec.bindings) {
      await channel.bindQueue(spec.queue, EXCHANGE, type);
    }
    const delays = spec.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (const [index, delay] of delays.entries()) {
      await channel.assertQueue(retryQueueOf(spec.queue, index + 1), {
        durable: true,
        messageTtl: delay,
        deadLetterExchange: '',
        deadLetterRoutingKey: spec.queue,
      });
    }
    await channel.assertQueue(deadQueueOf(spec.queue), { durable: true });
  }
}
