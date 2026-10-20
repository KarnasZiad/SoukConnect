/**
 * A failure that no retry can fix: the message is out of sequence for the state machine, or breaks
 * a business invariant. The consumer moves it to the dead-letter queue at once.
 */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** The message cannot be read: unknown type, malformed JSON, payload that fails its schema. */
export class InvalidMessageError extends PermanentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidMessageError';
  }
}
