import type { Envelope, MessageType } from '@soukconnect/contracts';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { attemptsOf, fromWire } from './codec.js';
import { PermanentError } from './errors.js';
import type { Logger } from './logger.js';
import { DEFAULT_RETRY_DELAYS_MS, deadQueueOf, retryQueueOf } from './topology.js';

export interface DeliveryContext {
  /** Retries already made: 0 on the first delivery. */
  attempt: number;
  /** The broker delivered it before (consumer stopped mid-way): the inbox makes this harmless. */
  redelivered: boolean;
}

export type Handler<T extends MessageType> = (
  envelope: Envelope<T>,
  context: DeliveryContext,
) => Promise<void>;

export type Handlers = { [T in MessageType]?: Handler<T> };

export interface ConsumerOptions {
  queue: string;
  handlers: Handlers;
  logger: Logger;
  retryDelaysMs?: readonly number[];
  /** Messages in flight at once on this consumer. */
  prefetch?: number;
}

export interface Consumer {
  /** Stops receiving, then waits for the messages being handled. */
  stop(): Promise<void>;
}

const MAX_REASON_LENGTH = 500;

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_REASON_LENGTH);
}

/**
 * Consumes a queue with manual acknowledgement. A message is acknowledged only after its handler
 * resolved, or after a copy was confirmed in a retry or dead-letter queue: nothing is lost if the
 * process stops at any point, at worst it is delivered again.
 */
export async function startConsumer(
  channel: ConfirmChannel,
  options: ConsumerOptions,
): Promise<Consumer> {
  const { queue, handlers, logger } = options;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const inFlight = new Set<Promise<void>>();

  async function moveTo(target: string, message: ConsumeMessage, headers: object): Promise<void> {
    channel.sendToQueue(target, message.content, {
      ...message.properties,
      headers: { ...message.properties.headers, ...headers },
    });
    await channel.waitForConfirms();
  }

  async function handle(message: ConsumeMessage): Promise<void> {
    const attempt = attemptsOf(message);
    const fields = {
      queue,
      messageId: message.properties.messageId as unknown,
      type: message.properties.type as unknown,
      correlationId: message.properties.correlationId as unknown,
      attempt,
    };
    try {
      let envelope: Envelope;
      try {
        envelope = fromWire(message);
      } catch (error) {
        logger.error({ ...fields, err: error }, 'invalid message dead-lettered');
        await moveTo(deadQueueOf(queue), message, { 'x-dead-reason': describe(error) });
        channel.ack(message);
        return;
      }
      const handler = handlers[envelope.type] as Handler<MessageType> | undefined;
      if (!handler) {
        // A binding without a handler is a deployment mistake: keep the message for a replay.
        logger.error(fields, 'no handler for this message type: dead-lettered');
        await moveTo(deadQueueOf(queue), message, {
          'x-dead-reason': `No handler for ${envelope.type} on ${queue}`,
        });
        channel.ack(message);
        return;
      }
      try {
        await handler(envelope, { attempt, redelivered: message.fields.redelivered });
        channel.ack(message);
      } catch (error) {
        if (error instanceof PermanentError || attempt >= delays.length) {
          logger.error({ ...fields, err: error }, 'message dead-lettered');
          await moveTo(deadQueueOf(queue), message, {
            'x-dead-reason': describe(error),
            'x-failed-at': new Date().toISOString(),
          });
        } else {
          logger.warn({ ...fields, err: error }, 'handler failed: message scheduled for a retry');
          await moveTo(retryQueueOf(queue, attempt + 1), message, { 'x-attempts': attempt + 1 });
        }
        channel.ack(message);
      }
    } catch (error) {
      // The broker refused the copy: give the message back, it will be delivered again.
      logger.error({ ...fields, err: error }, 'could not settle the message: requeued');
      channel.nack(message, false, true);
    }
  }

  await channel.prefetch(options.prefetch ?? 16);
  const { consumerTag } = await channel.consume(
    queue,
    (message) => {
      if (message === null) {
        logger.warn({ queue }, 'consumer cancelled by the broker');
        return;
      }
      const task = handle(message).finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    { noAck: false },
  );
  logger.info({ queue, prefetch: options.prefetch ?? 16 }, 'consumer started');

  return {
    async stop() {
      await channel.cancel(consumerTag);
      await Promise.allSettled([...inFlight]);
    },
  };
}
