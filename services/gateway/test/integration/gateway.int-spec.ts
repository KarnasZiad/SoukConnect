import { fileURLToPath } from 'node:url';
import { createLogger, generateSigningKeys, importSigningKey } from '@soukconnect/service-kit';
import { connectPostgres, migrate } from '@soukconnect/service-kit/postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PostgresAccountStore } from '../../src/auth/accounts.js';
import { RedisLoginGuard } from '../../src/auth/login-guard.js';
import { digest, RedisSessionStore } from '../../src/auth/sessions.js';
import { MAX_LINES, RedisCartStore } from '../../src/cart/cart-store.js';
import { FakeInternal, ORIGIN } from '../fakes.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let sql: Sql;
let redis: Redis;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7.4-alpine').start(),
  ]);
  sql = connectPostgres(pg.getConnectionUri());
  expect(await migrate(sql, MIGRATIONS)).toEqual(['0001_accounts']);
  redis = new Redis(redisContainer.getConnectionUrl());
});

afterAll(async () => {
  redis.disconnect();
  await sql.end();
  await Promise.all([pg.stop(), redisContainer.stop()]);
});

beforeEach(async () => {
  await sql`truncate accounts`;
  await redis.flushall();
});

const profile = {
  displayName: 'Amina',
  role: 'buyer' as const,
  locale: 'fr' as const,
  passwordHash: 'hash',
};

describe('accounts in PostgreSQL', () => {
  it('normalizes the e-mail, refuses a second account, and erases a deleted one', async () => {
    const accounts = new PostgresAccountStore(sql);
    const created = await accounts.create({ ...profile, email: ' Amina@Example.MA ' });
    if (created === 'email-taken') throw new Error('unexpected');

    expect(created.email).toBe('amina@example.ma');
    expect(await accounts.create({ ...profile, email: 'AMINA@example.ma' })).toBe('email-taken');
    expect((await accounts.findByEmail('amina@EXAMPLE.ma'))?.passwordHash).toBe('hash');

    await accounts.delete(created.id);
    expect(await accounts.findById(created.id)).toBeNull();
    expect(await accounts.findByEmail('amina@example.ma')).toBeNull();
    const [row] = await sql<
      { email: string; password_hash: string | null; display_name: string }[]
    >`
      select email, password_hash, display_name from accounts where id = ${created.id}`;
    expect(row).toEqual({
      email: `deleted+${created.id}@invalid`,
      password_hash: null,
      display_name: 'Compte supprimé',
    });
    // The address is free again for a new account.
    expect(await accounts.create({ ...profile, email: 'amina@example.ma' })).not.toBe(
      'email-taken',
    );
  });
});

describe('sessions in Redis', () => {
  it('stores only the digest of the identifier, slides the expiry and revokes all sessions', async () => {
    const sessions = new RedisSessionStore(redis, 60);
    const session = {
      userId: '0199f0a4-7a5b-7c1e-9f00-0000000000b1',
      role: 'buyer' as const,
      createdAt: 1,
    };
    const first = await sessions.create(session);
    const second = await sessions.create(session);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await redis.keys('*')).not.toContain(`sess:${first}`);
    const key = `sess:${digest(first)}`;
    await redis.expire(key, 5);
    expect(await sessions.get(first)).toEqual(session);
    // Reading the session pushed its expiry back to the full window.
    expect(await redis.ttl(key)).toBeGreaterThan(50);
    expect(await sessions.get('not-a-session')).toBeNull();

    await sessions.destroy(first);
    expect(await sessions.get(first)).toBeNull();
    expect(await sessions.get(second)).toEqual(session);
    await sessions.destroyAllOf(session.userId);
    expect(await sessions.get(second)).toBeNull();
  });
});

describe('login guard in Redis', () => {
  it('locks after five failures and unlocks on success', async () => {
    const guard = new RedisLoginGuard(redis);
    const now = Date.now();
    for (let attempt = 0; attempt < 4; attempt += 1) await guard.failed('amina@example.ma', now);
    expect(await guard.lockedFor('AMINA@example.ma', now)).toBe(0);

    await guard.failed('amina@example.ma', now);
    expect(await guard.lockedFor('amina@example.ma', now)).toBe(60);
    expect(await guard.lockedFor('amina@example.ma', now + 61_000)).toBe(0);
    expect(await redis.keys('*')).not.toContain('amina@example.ma');

    await guard.succeeded('amina@example.ma');
    expect(await guard.lockedFor('amina@example.ma', now)).toBe(0);
  });
});

describe('carts in Redis', () => {
  it('bounds a cart, merges a guest cart into the account and keeps carts for 30 days', async () => {
    const carts = new RedisCartStore(redis);
    for (let index = 0; index < MAX_LINES; index += 1) {
      expect(await carts.set('guest:g', `product-${index}`, 1)).toBe('ok');
    }
    expect(await carts.set('guest:g', 'one-too-many', 1)).toBe('too-many-lines');
    expect(await carts.set('guest:g', 'product-0', 3)).toBe('ok');
    await carts.set('user:u', 'product-0', 98);

    await carts.merge('guest:g', 'user:u');

    const merged = await carts.get('user:u');
    expect(merged.size).toBe(MAX_LINES);
    expect(merged.get('product-0')).toBe(99);
    expect((await carts.get('guest:g')).size).toBe(0);
    expect(await redis.ttl('cart:user:u')).toBeGreaterThan(29 * 86_400);
    await carts.set('user:u', 'product-0', 0);
    expect((await carts.get('user:u')).has('product-0')).toBe(false);
  });
});

describe('the gateway on its real stores', () => {
  it('signs up, keeps the session in Redis and finds the account again after a restart', async () => {
    const { privateJwk } = await generateSigningKeys('it');
    const build = async () =>
      buildApp({
        logger: createLogger('gateway-it', 'silent'),
        accounts: new PostgresAccountStore(sql),
        sessions: new RedisSessionStore(redis, 3600),
        guard: new RedisLoginGuard(redis),
        carts: new RedisCartStore(redis),
        internal: new FakeInternal(),
        signingKey: await importSigningKey(JSON.stringify(privateJwk)),
        upstreams: {
          catalog: 'http://127.0.0.1:9',
          orders: 'http://127.0.0.1:9',
          payments: 'http://127.0.0.1:9',
          notifications: 'http://127.0.0.1:9',
        },
        publicOrigin: ORIGIN,
        cookieSecure: true,
        sessionDays: 7,
        redis,
      });
    const first = await build();
    const registered = await first.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: ORIGIN },
      payload: {
        email: 'amina@example.ma',
        password: 'tapis de laine du moyen atlas',
        displayName: 'Amina',
        role: 'buyer',
      },
    });
    expect(registered.statusCode).toBe(201);
    const cookie = registered.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
    await first.close();

    // Another replica, or the same one restarted: the session is in Redis, not in memory.
    const second = await build();
    const me = await second.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ email: 'amina@example.ma' });
    await second.close();
  });
});
