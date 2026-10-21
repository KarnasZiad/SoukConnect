import type { Redis } from 'ioredis';

export const MAX_LINES = 50;
export const MAX_QUANTITY = 99;
const TTL_SECONDS = 30 * 24 * 3600;

export type Cart = Map<string, number>;

/**
 * A guest cart added to the cart of the account at sign-in (US-04): quantities add up, within
 * the limits of an order; lines beyond the limit are dropped, the account's own lines first kept.
 */
export function mergeCarts(account: Cart, guest: Cart): Cart {
  const merged = new Map(account);
  for (const [productId, quantity] of guest) {
    if (!merged.has(productId) && merged.size >= MAX_LINES) continue;
    merged.set(productId, Math.min(MAX_QUANTITY, (merged.get(productId) ?? 0) + quantity));
  }
  return merged;
}

export interface CartStore {
  get(owner: string): Promise<Cart>;
  /** A quantity of 0 removes the line. */
  set(owner: string, productId: string, quantity: number): Promise<'ok' | 'too-many-lines'>;
  clear(owner: string): Promise<void>;
  /** Moves the guest cart into the account's cart. */
  merge(guest: string, account: string): Promise<void>;
}

/** One Redis hash per cart (productId → quantity), kept 30 days after its last change. */
export class RedisCartStore implements CartStore {
  constructor(private readonly redis: Redis) {}

  private key(owner: string): string {
    return `cart:${owner}`;
  }

  async get(owner: string): Promise<Cart> {
    const entries = await this.redis.hgetall(this.key(owner));
    return new Map(
      Object.entries(entries).map(([productId, quantity]) => [productId, Number(quantity)]),
    );
  }

  async set(owner: string, productId: string, quantity: number): Promise<'ok' | 'too-many-lines'> {
    const key = this.key(owner);
    if (quantity === 0) {
      await this.redis.hdel(key, productId);
      return 'ok';
    }
    const [exists, size] = await Promise.all([
      this.redis.hexists(key, productId),
      this.redis.hlen(key),
    ]);
    if (!exists && size >= MAX_LINES) return 'too-many-lines';
    await this.redis.multi().hset(key, productId, String(quantity)).expire(key, TTL_SECONDS).exec();
    return 'ok';
  }

  async clear(owner: string): Promise<void> {
    await this.redis.del(this.key(owner));
  }

  async merge(guest: string, account: string): Promise<void> {
    const [guestCart, accountCart] = await Promise.all([this.get(guest), this.get(account)]);
    if (guestCart.size === 0) return;
    const merged = mergeCarts(accountCart, guestCart);
    const key = this.key(account);
    await this.redis
      .multi()
      .del(key)
      .hset(
        key,
        Object.fromEntries(
          [...merged].map(([productId, quantity]) => [productId, String(quantity)]),
        ),
      )
      .expire(key, TTL_SECONDS)
      .del(this.key(guest))
      .exec();
  }
}
