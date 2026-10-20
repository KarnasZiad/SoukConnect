import { createEnvelope } from '@soukconnect/contracts';
import { describe, expect, it, vi } from 'vitest';
import { deliveryOf, FakeChannel, settle, silentLogger } from '../test/fake-channel.js';
import { toWire } from './codec.js';
import { type Handlers, startConsumer } from './consumer.js';
import { PermanentError } from './errors.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';
const envelope = createEnvelope('catalog.commit-stock', { orderId }, { correlationId: orderId });

async function consumer(handlers: Handlers, retryDelaysMs = [1000, 10_000]) {
  const channel = new FakeChannel();
  const logger = silentLogger();
  const started = await startConsumer(channel.asChannel(), {
    queue: 'catalog.commands',
    handlers,
    logger,
    retryDelaysMs,
    prefetch: 4,
  });
  return { channel, logger, started };
}

describe('startConsumer', () => {
  it('hands a valid message to its handler, then acknowledges it', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const { channel } = await consumer({ 'catalog.commit-stock': handler });
    const message = deliveryOf(envelope, { redelivered: true });

    channel.deliver(message);
    await settle();

    expect(channel.prefetchCount).toBe(4);
    expect(handler).toHaveBeenCalledWith(envelope, { attempt: 0, redelivered: true });
    expect(channel.acked).toEqual([message]);
    expect(channel.sent).toEqual([]);
  });

  it('schedules a failed message in the retry queue of its next attempt', async () => {
    const { channel, logger } = await consumer({
      'catalog.commit-stock': () => Promise.reject(new Error('database unavailable')),
    });
    const message = deliveryOf(envelope, { headers: { 'x-attempts': 1 } });

    channel.deliver(message);
    await settle();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.routingKey).toBe('catalog.commands.retry.2');
    expect(channel.sent[0]?.options.headers).toMatchObject({ 'x-attempts': 2 });
    expect(channel.sent[0]?.options.messageId).toBe(envelope.id);
    expect(channel.acked).toEqual([message]);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'handler failed: message scheduled for a retry',
    });
  });

  it('dead-letters a message once its retries are exhausted', async () => {
    const { channel } = await consumer({
      'catalog.commit-stock': () => Promise.reject(new Error('still failing')),
    });

    channel.deliver(deliveryOf(envelope, { headers: { 'x-attempts': 2 } }));
    await settle();

    expect(channel.sent[0]?.routingKey).toBe('catalog.commands.dead');
    expect(channel.sent[0]?.options.headers).toMatchObject({
      'x-dead-reason': 'Error: still failing',
    });
    expect(channel.acked).toHaveLength(1);
  });

  it('dead-letters a permanent failure without retrying', async () => {
    const { channel } = await consumer({
      'catalog.commit-stock': () => Promise.reject(new PermanentError('Order is not reserved')),
    });

    channel.deliver(deliveryOf(envelope));
    await settle();

    expect(channel.sent.map((sent) => sent.routingKey)).toEqual(['catalog.commands.dead']);
    expect(channel.sent[0]?.options.headers).toMatchObject({
      'x-dead-reason': 'PermanentError: Order is not reserved',
    });
  });

  it('dead-letters an invalid message without calling any handler', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const { channel } = await consumer({ 'catalog.commit-stock': handler });
    const wire = toWire(envelope);

    channel.deliver(deliveryOf({ content: Buffer.from('{"orderId":1}'), options: wire.options }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    expect(channel.sent[0]?.routingKey).toBe('catalog.commands.dead');
    expect(String(channel.sent[0]?.options.headers?.['x-dead-reason'])).toMatch(/schema/);
  });

  it('dead-letters a message bound to the queue but without a handler', async () => {
    const { channel } = await consumer({});

    channel.deliver(deliveryOf(envelope));
    await settle();

    expect(channel.sent[0]?.options.headers).toMatchObject({
      'x-dead-reason': 'No handler for catalog.commit-stock on catalog.commands',
    });
    expect(channel.acked).toHaveLength(1);
  });

  it('gives the message back when the broker refuses the retry copy', async () => {
    const { channel } = await consumer({
      'catalog.commit-stock': () => Promise.reject(new Error('boom')),
    });
    channel.confirmError = new Error('channel closed');
    const message = deliveryOf(envelope);

    channel.deliver(message);
    await settle();

    expect(channel.acked).toEqual([]);
    expect(channel.nacked).toEqual([{ message, requeue: true }]);
  });

  it('stops receiving, then waits for the message being handled', async () => {
    let finish: () => void = () => undefined;
    const { channel, started } = await consumer({
      'catalog.commit-stock': () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });

    channel.deliver(deliveryOf(envelope));
    await settle();
    let stopped = false;
    const stopping = started.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(channel.cancelled).toEqual(['ctag-1']);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(channel.acked).toHaveLength(1);
  });

  it('logs a cancellation by the broker', async () => {
    const { channel, logger } = await consumer({});
    channel.deliver(null);

    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'consumer cancelled by the broker',
    });
  });
});
