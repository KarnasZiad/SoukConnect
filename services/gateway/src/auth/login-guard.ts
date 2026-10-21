import type { Redis } from 'ioredis';
import { normalizeEmail } from './accounts.js';
import { digest } from './sessions.js';

/** Failures allowed before the account is locked. */
export const FREE_ATTEMPTS = 5;

/**
 * Progressive lock (S1): one minute after the fifth failure, doubling with each further failure,
 * at most one hour. A legitimate user waits a little; a guessing attack slows to a crawl.
 */
export function lockSeconds(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(60 * 2 ** (failures - FREE_ATTEMPTS), 3600);
}

export interface LoginGuard {
  /** Seconds before the next attempt is allowed; 0 when not locked. */
  lockedFor(email: string, now?: number): Promise<number>;
  failed(email: string, now?: number): Promise<void>;
  succeeded(email: string): Promise<void>;
}

/** Counters in Redis, keyed by the digest of the e-mail: no address is stored in clear. */
export class RedisLoginGuard implements LoginGuard {
  constructor(private readonly redis: Redis) {}

  private key(email: string): string {
    return `login:${digest(normalizeEmail(email))}`;
  }

  async lockedFor(email: string, now = Date.now()): Promise<number> {
    const until = Number((await this.redis.hget(this.key(email), 'lockedUntil')) ?? 0);
    return Math.max(0, Math.ceil((until - now) / 1000));
  }

  async failed(email: string, now = Date.now()): Promise<void> {
    const key = this.key(email);
    const failures = await this.redis.hincrby(key, 'failures', 1);
    const seconds = lockSeconds(failures);
    const pipeline = this.redis.multi().expire(key, 24 * 3600);
    if (seconds > 0) pipeline.hset(key, 'lockedUntil', String(now + seconds * 1000));
    await pipeline.exec();
  }

  async succeeded(email: string): Promise<void> {
    await this.redis.del(this.key(email));
  }
}
