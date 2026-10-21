import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { closeOnSignals } from './shutdown.js';

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    exit: vi.fn<(code: number) => void>(),
    once(signal: NodeJS.Signals, listener: () => void) {
      listeners.set(signal, listener);
    },
  };
}

const logger = pino({ level: 'silent' });

describe('closeOnSignals', () => {
  it('closes once on SIGTERM, then exits cleanly', async () => {
    const target = fakeProcess();
    const close = vi.fn(() => Promise.resolve());
    closeOnSignals(logger, close, { process: target });

    target.listeners.get('SIGTERM')?.();
    target.listeners.get('SIGINT')?.();
    await vi.waitFor(() => {
      expect(target.exit).toHaveBeenCalledWith(0);
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('exits with an error when closing fails', async () => {
    const target = fakeProcess();
    closeOnSignals(logger, () => Promise.reject(new Error('stuck consumer')), { process: target });

    target.listeners.get('SIGINT')?.();
    await vi.waitFor(() => {
      expect(target.exit).toHaveBeenCalledWith(1);
    });
  });

  it('cuts a shutdown that hangs', async () => {
    vi.useFakeTimers();
    try {
      const target = fakeProcess();
      closeOnSignals(logger, () => new Promise(() => undefined), {
        process: target,
        timeoutMs: 500,
      });

      target.listeners.get('SIGTERM')?.();
      await vi.advanceTimersByTimeAsync(500);
      expect(target.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
