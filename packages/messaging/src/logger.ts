/** The subset of Pino the messaging code logs with: structured fields first, then the message. */
export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}
