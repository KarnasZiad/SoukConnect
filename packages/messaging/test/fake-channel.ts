import { EventEmitter } from 'node:events';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { toWire } from '../src/codec.js';
import type { Logger } from '../src/logger.js';
import type { Envelope } from '@soukconnect/contracts';

export interface Sent {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
}

/**
 * In-memory stand-in for an amqplib confirm channel: records what is published, sent, acked and
 * nacked, and lets a test deliver messages to the registered consumer.
 */
export class FakeChannel extends EventEmitter {
  published: Sent[] = [];
  sent: Sent[] = [];
  acked: ConsumeMessage[] = [];
  nacked: { message: ConsumeMessage; requeue: boolean }[] = [];
  declared: { kind: string; args: unknown[] }[] = [];
  prefetchCount = 0;
  cancelled: string[] = [];
  /** When set, waitForConfirms rejects with it: the broker refused a message. */
  confirmError: Error | null = null;
  /** When false, publish reports a full buffer and the publisher must wait for 'drain'. */
  bufferAvailable = true;
  private onMessage: ((message: ConsumeMessage | null) => void) | null = null;

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
  ): boolean {
    this.published.push({ exchange, routingKey, content, options });
    return this.bufferAvailable;
  }

  sendToQueue(queue: string, content: Buffer, options: Options.Publish): boolean {
    this.sent.push({ exchange: '', routingKey: queue, content, options });
    return true;
  }

  waitForConfirms(): Promise<void> {
    return this.confirmError ? Promise.reject(this.confirmError) : Promise.resolve();
  }

  ack(message: ConsumeMessage): void {
    this.acked.push(message);
  }

  nack(message: ConsumeMessage, _allUpTo?: boolean, requeue = true): void {
    this.nacked.push({ message, requeue });
  }

  prefetch(count: number): Promise<object> {
    this.prefetchCount = count;
    return Promise.resolve({});
  }

  consume(
    _queue: string,
    onMessage: (message: ConsumeMessage | null) => void,
  ): Promise<{ consumerTag: string }> {
    this.onMessage = onMessage;
    return Promise.resolve({ consumerTag: 'ctag-1' });
  }

  cancel(consumerTag: string): Promise<object> {
    this.cancelled.push(consumerTag);
    return Promise.resolve({});
  }

  assertExchange(...args: unknown[]): Promise<object> {
    this.declared.push({ kind: 'exchange', args });
    return Promise.resolve({});
  }

  assertQueue(...args: unknown[]): Promise<object> {
    this.declared.push({ kind: 'queue', args });
    return Promise.resolve({});
  }

  bindQueue(...args: unknown[]): Promise<object> {
    this.declared.push({ kind: 'binding', args });
    return Promise.resolve({});
  }

  /** Delivers a raw message to the consumer, as the broker would. */
  deliver(message: ConsumeMessage | null): void {
    if (!this.onMessage) throw new Error('No consumer registered');
    this.onMessage(message);
  }

  asChannel(): ConfirmChannel {
    return this as unknown as ConfirmChannel;
  }
}

let deliveryTag = 0;

/** A delivered message as amqplib builds it, from an envelope or from raw parts. */
export function deliveryOf(
  source: Envelope | { content: Buffer; options: Options.Publish },
  extra: { headers?: Record<string, unknown>; redelivered?: boolean } = {},
): ConsumeMessage {
  const wire = 'content' in source ? source : toWire(source);
  deliveryTag += 1;
  return {
    content: wire.content,
    fields: {
      deliveryTag,
      redelivered: extra.redelivered ?? false,
      exchange: 'souk.events',
      routingKey: wire.options.type ?? '',
      consumerTag: 'ctag-1',
    },
    properties: {
      contentType: wire.options.contentType,
      contentEncoding: undefined,
      headers: { ...(wire.options.headers as object), ...extra.headers },
      deliveryMode: 2,
      priority: undefined,
      correlationId: wire.options.correlationId,
      replyTo: undefined,
      expiration: undefined,
      messageId: wire.options.messageId,
      timestamp: wire.options.timestamp,
      type: wire.options.type,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

export function silentLogger(): Logger & { entries: { level: string; message: string }[] } {
  const entries: { level: string; message: string }[] = [];
  return {
    entries,
    info: (_fields, message) => entries.push({ level: 'info', message }),
    warn: (_fields, message) => entries.push({ level: 'warn', message }),
    error: (_fields, message) => entries.push({ level: 'error', message }),
  };
}

/** Lets queued promise callbacks run. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
