import { uuidv7 } from './ids.js';
import { type MessagePayload, type MessageType, parsePayload } from './messages.js';

/**
 * A message and its metadata. On the wire, the metadata travels in AMQP properties and the body is
 * the JSON payload (docs/architecture/messaging.md).
 */
export interface Envelope<T extends MessageType = MessageType> {
  /** UUID v7; the deduplication key of the inbox. */
  id: string;
  type: T;
  /** When the fact happened (ISO 8601), not when it was sent. */
  occurredAt: string;
  /** Follows the whole saga: the order identifier. */
  correlationId: string;
  /** Identifier of the message that caused this one, if any. */
  causationId: string | null;
  payload: MessagePayload<T>;
}

/**
 * Either the start of a flow (an HTTP request: the correlation is given), or a message caused by
 * the one being handled (its id becomes the causation, its correlation is inherited).
 */
export type EnvelopeOptions = { now?: Date } & (
  { correlationId: string } | { causedBy: Pick<Envelope, 'id' | 'correlationId'> }
);

/** Builds a message, validating its payload: a producer never sends what a consumer would refuse. */
export function createEnvelope<T extends MessageType>(
  type: T,
  payload: MessagePayload<T>,
  options: EnvelopeOptions,
): Envelope<T> {
  const now = options.now ?? new Date();
  const origin =
    'causedBy' in options
      ? { correlationId: options.causedBy.correlationId, causationId: options.causedBy.id }
      : { correlationId: options.correlationId, causationId: null };
  return {
    id: uuidv7(now.getTime()),
    type,
    occurredAt: now.toISOString(),
    ...origin,
    payload: parsePayload(type, payload),
  };
}
