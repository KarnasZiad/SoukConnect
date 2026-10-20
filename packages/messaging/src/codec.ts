import { type Envelope, isMessageType, parsePayload } from '@soukconnect/contracts';
import type { Message, Options } from 'amqplib';
import { InvalidMessageError } from './errors.js';

export interface WireMessage {
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
}

/** Metadata in AMQP properties, payload as the JSON body (docs/architecture/messaging.md). */
export function toWire(envelope: Envelope): WireMessage {
  return {
    routingKey: envelope.type,
    content: Buffer.from(JSON.stringify(envelope.payload)),
    options: {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.id,
      type: envelope.type,
      correlationId: envelope.correlationId,
      // AMQP timestamps have a one-second resolution: the exact date travels in a header.
      timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
      headers: {
        'x-occurred-at': envelope.occurredAt,
        ...(envelope.causationId === null ? {} : { 'x-causation-id': envelope.causationId }),
      },
    },
  };
}

function header(message: Message, name: string): string | undefined {
  const value: unknown = message.properties.headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** Reads and validates a delivered message; throws InvalidMessageError when it cannot be trusted. */
export function fromWire(message: Message): Envelope {
  const { messageId, type, correlationId } = message.properties as {
    messageId?: unknown;
    type?: unknown;
    correlationId?: unknown;
  };
  if (typeof messageId !== 'string' || messageId === '') {
    throw new InvalidMessageError('Message without an identifier');
  }
  if (!isMessageType(type)) {
    throw new InvalidMessageError(`Unknown message type: ${String(type)}`);
  }
  if (typeof correlationId !== 'string' || correlationId === '') {
    throw new InvalidMessageError('Message without a correlation identifier');
  }
  let body: unknown;
  try {
    body = JSON.parse(message.content.toString('utf8'));
  } catch (error) {
    throw new InvalidMessageError('Message body is not JSON', { cause: error });
  }
  try {
    return {
      id: messageId,
      type,
      occurredAt: header(message, 'x-occurred-at') ?? new Date().toISOString(),
      correlationId,
      causationId: header(message, 'x-causation-id') ?? null,
      payload: parsePayload(type, body),
    };
  } catch (error) {
    throw new InvalidMessageError(`Payload of ${type} does not match its schema`, { cause: error });
  }
}

/** Retry and dead-letter counts travel in headers; a missing or forged value counts as zero. */
export function attemptsOf(message: Message): number {
  const value: unknown = message.properties.headers?.['x-attempts'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
