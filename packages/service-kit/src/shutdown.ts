import type { Logger } from 'pino';

interface ProcessLike {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
}

export interface ShutdownOptions {
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  /** Replaced in tests. */
  process?: ProcessLike;
}

/**
 * On SIGTERM (Kubernetes) or SIGINT: run `close` once (stop consumers and relays, drain HTTP,
 * close connections), then exit. A shutdown that hangs is cut short so the pod does not linger.
 */
export function closeOnSignals(
  logger: Logger,
  close: () => Promise<void>,
  options: ShutdownOptions = {},
): void {
  const target = options.process ?? process;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let closing = false;
  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) {
    target.once(signal, () => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      const timer = setTimeout(() => {
        logger.error({ timeoutMs }, 'shutdown timed out');
        target.exit(1);
      }, timeoutMs);
      timer.unref();
      close().then(
        () => {
          clearTimeout(timer);
          target.exit(0);
        },
        (error: unknown) => {
          clearTimeout(timer);
          logger.error({ err: error }, 'shutdown failed');
          target.exit(1);
        },
      );
    });
  }
}
