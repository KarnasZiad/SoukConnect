import { createEnvelope } from '@soukconnect/contracts';
import { describe, expect, it } from 'vitest';
import { FakeChannel, settle } from '../test/fake-channel.js';
import { publish } from './publisher.js';
import { EXCHANGE } from './topology.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';

describe('publish', () => {
  const envelopes = [
    createEnvelope('catalog.commit-stock', { orderId }, { correlationId: orderId }),
    createEnvelope(
      'catalog.release-stock',
      { orderId, reason: 'test' },
      { correlationId: orderId },
    ),
  ];

  it('publishes every message to the exchange, then waits for the confirmations', async () => {
    const channel = new FakeChannel();
    await publish(channel.asChannel(), envelopes);

    expect(channel.published.map((sent) => [sent.exchange, sent.routingKey])).toEqual([
      [EXCHANGE, 'catalog.commit-stock'],
      [EXCHANGE, 'catalog.release-stock'],
    ]);
  });

  it('rejects when the broker refuses a message', async () => {
    const channel = new FakeChannel();
    channel.confirmError = new Error('nack');

    await expect(publish(channel.asChannel(), envelopes)).rejects.toThrow('nack');
  });

  it('waits for the channel to drain when its buffer is full', async () => {
    const channel = new FakeChannel();
    channel.bufferAvailable = false;
    let done = false;
    const publishing = publish(channel.asChannel(), envelopes).then(() => {
      done = true;
    });

    await settle();
    expect(channel.published).toHaveLength(1);
    expect(done).toBe(false);

    channel.bufferAvailable = true;
    channel.emit('drain');
    await publishing;
    expect(channel.published).toHaveLength(2);
  });
});
