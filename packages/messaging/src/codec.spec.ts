import { createEnvelope } from '@soukconnect/contracts';
import { describe, expect, it } from 'vitest';
import { deliveryOf } from '../test/fake-channel.js';
import { attemptsOf, fromWire, toWire } from './codec.js';
import { InvalidMessageError } from './errors.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';
const now = new Date('2026-10-21T08:00:00.123Z');

describe('codec', () => {
  const cause = createEnvelope(
    'catalog.reserve-stock',
    {
      orderId,
      items: [{ productId: '0199f0a4-7a5b-7c1e-9f00-00000000000d', quantity: 1 }],
    },
    { correlationId: orderId, now },
  );
  const envelope = createEnvelope('catalog.commit-stock', { orderId }, { causedBy: cause, now });

  it('puts the metadata in AMQP properties and the payload in the body', () => {
    const wire = toWire(envelope);

    expect(wire.routingKey).toBe('catalog.commit-stock');
    expect(JSON.parse(wire.content.toString())).toEqual({ orderId });
    expect(wire.options).toMatchObject({
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.id,
      type: 'catalog.commit-stock',
      correlationId: orderId,
      timestamp: Math.floor(now.getTime() / 1000),
      headers: { 'x-occurred-at': '2026-10-21T08:00:00.123Z', 'x-causation-id': cause.id },
    });
  });

  it('reads back exactly what was written', () => {
    expect(fromWire(deliveryOf(envelope))).toEqual(envelope);
    expect(fromWire(deliveryOf(cause))).toEqual(cause);
  });

  it.each([
    ['no identifier', { messageId: undefined }, /without an identifier/],
    ['an unknown type', { type: 'catalog.drop-tables' }, /Unknown message type/],
    ['no correlation', { correlationId: '' }, /correlation/],
  ])('refuses a message with %s', (_label, override, pattern) => {
    const wire = toWire(envelope);
    const message = deliveryOf({
      content: wire.content,
      options: { ...wire.options, ...override },
    });

    expect(() => fromWire(message)).toThrow(InvalidMessageError);
    expect(() => fromWire(message)).toThrow(pattern);
  });

  it('refuses a body that is not JSON or does not match the schema', () => {
    const wire = toWire(envelope);

    expect(() =>
      fromWire(deliveryOf({ content: Buffer.from('{oops'), options: wire.options })),
    ).toThrow(/not JSON/);
    expect(() =>
      fromWire(deliveryOf({ content: Buffer.from('{"orderId":"x"}'), options: wire.options })),
    ).toThrow(/does not match its schema/);
  });

  it('counts the attempts from a trusted integer header only', () => {
    expect(attemptsOf(deliveryOf(envelope))).toBe(0);
    expect(attemptsOf(deliveryOf(envelope, { headers: { 'x-attempts': 2 } }))).toBe(2);
    expect(attemptsOf(deliveryOf(envelope, { headers: { 'x-attempts': '9' } }))).toBe(0);
    expect(attemptsOf(deliveryOf(envelope, { headers: { 'x-attempts': -1 } }))).toBe(0);
  });
});
