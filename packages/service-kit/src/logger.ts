import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Never logged: credentials, session cookies, internal tokens, and the personal data a request may
 * carry (e-mail addresses, delivery addresses, phone numbers).
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.email',
  '*.phone',
  '*.shippingAddress',
];

export function loggerOptions(service: string, level: string): LoggerOptions {
  return {
    level,
    base: { service },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/** JSON logs on stdout, one line per event, tagged with the service name. */
export function createLogger(service: string, level = 'info'): Logger {
  return pino(loggerOptions(service, level));
}

export type { Logger };
