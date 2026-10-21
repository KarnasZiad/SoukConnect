import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@soukconnect/contracts';
import type { Redis } from 'ioredis';

export interface Session {
  userId: string;
  role: Role;
  createdAt: number;
}

export interface SessionStore {
  /** Returns the opaque identifier that goes in the cookie. */
  create(session: Session): Promise<string>;
  /** The session of a cookie, with its expiry pushed back (sliding window). */
  get(id: string): Promise<Session | null>;
  destroy(id: string): Promise<void>;
  /** Signs a person out everywhere (password change, account deletion). */
  destroyAllOf(userId: string): Promise<void>;
}

/** 256 random bits in base64url: 43 characters. */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Sessions in Redis under the SHA-256 of their identifier: a dump of Redis gives no usable
 * cookie. Each person has a set of their sessions, to revoke them all at once.
 */
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  private key(id: string): string {
    return `sess:${digest(id)}`;
  }

  async create(session: Session): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    const key = this.key(id);
    const index = `user-sess:${session.userId}`;
    await this.redis
      .multi()
      .set(key, JSON.stringify(session), 'EX', this.ttlSeconds)
      .sadd(index, key)
      .expire(index, this.ttlSeconds)
      .exec();
    return id;
  }

  async get(id: string): Promise<Session | null> {
    if (!SESSION_ID.test(id)) return null;
    const raw = await this.redis.getex(this.key(id), 'EX', this.ttlSeconds);
    return raw === null ? null : (JSON.parse(raw) as Session);
  }

  async destroy(id: string): Promise<void> {
    if (!SESSION_ID.test(id)) return;
    const key = this.key(id);
    const raw = await this.redis.getdel(key);
    if (raw !== null)
      await this.redis.srem(`user-sess:${(JSON.parse(raw) as Session).userId}`, key);
  }

  async destroyAllOf(userId: string): Promise<void> {
    const index = `user-sess:${userId}`;
    const keys = await this.redis.smembers(index);
    await this.redis.del(index, ...keys);
  }
}
