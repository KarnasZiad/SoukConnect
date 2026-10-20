import { describe, expect, it } from 'vitest';
import { FakeChannel } from '../test/fake-channel.js';
import { declareTopology, deadQueueOf, EXCHANGE, retryQueueOf } from './topology.js';

describe('declareTopology', () => {
  it('declares only the exchange for a producer', async () => {
    const channel = new FakeChannel();
    await declareTopology(channel.asChannel());

    expect(channel.declared).toEqual([
      { kind: 'exchange', args: [EXCHANGE, 'topic', { durable: true }] },
    ]);
  });

  it('declares the queue of a consumer, its bindings, its retry and dead-letter queues', async () => {
    const channel = new FakeChannel();
    await declareTopology(channel.asChannel(), [
      {
        queue: 'orders.saga',
        bindings: ['catalog.stock-reserved', 'catalog.stock-rejected'],
        retryDelaysMs: [1000, 5000],
      },
    ]);

    expect(channel.declared.slice(1)).toEqual([
      {
        kind: 'queue',
        args: ['orders.saga', { durable: true, arguments: { 'x-queue-type': 'quorum' } }],
      },
      { kind: 'binding', args: ['orders.saga', EXCHANGE, 'catalog.stock-reserved'] },
      { kind: 'binding', args: ['orders.saga', EXCHANGE, 'catalog.stock-rejected'] },
      {
        kind: 'queue',
        args: [
          'orders.saga.retry.1',
          {
            durable: true,
            messageTtl: 1000,
            deadLetterExchange: '',
            deadLetterRoutingKey: 'orders.saga',
          },
        ],
      },
      {
        kind: 'queue',
        args: [
          'orders.saga.retry.2',
          {
            durable: true,
            messageTtl: 5000,
            deadLetterExchange: '',
            deadLetterRoutingKey: 'orders.saga',
          },
        ],
      },
      { kind: 'queue', args: ['orders.saga.dead', { durable: true }] },
    ]);
  });

  it('uses three retries by default', async () => {
    const channel = new FakeChannel();
    await declareTopology(channel.asChannel(), [{ queue: 'catalog.commands', bindings: [] }]);

    const queues = channel.declared
      .filter((entry) => entry.kind === 'queue')
      .map((entry) => entry.args[0]);
    expect(queues).toEqual([
      'catalog.commands',
      retryQueueOf('catalog.commands', 1),
      retryQueueOf('catalog.commands', 2),
      retryQueueOf('catalog.commands', 3),
      deadQueueOf('catalog.commands'),
    ]);
  });
});
