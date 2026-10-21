import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@soukconnect/contracts';
import {
  type Actor,
  createInternalVerifier,
  createLogger,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
} from '@soukconnect/service-kit';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  type Account,
  type AccountStore,
  type AccountWithSecret,
  normalizeEmail,
} from '../src/auth/accounts.js';
import { lockSeconds, type LoginGuard } from '../src/auth/login-guard.js';
import type { Session, SessionStore } from '../src/auth/sessions.js';
import { type Cart, type CartStore, MAX_LINES, mergeCarts } from '../src/cart/cart-store.js';
import type { OpenApiAggregator } from '../src/docs/openapi.js';
import type { InternalClient, UpstreamResponse } from '../src/proxy/internal-client.js';
import type { Upstream } from '../src/proxy/routing.js';

export const ORIGIN = 'https://soukconnect.test';

export class MemoryAccounts implements AccountStore {
  accounts = new Map<string, AccountWithSecret>();

  create(input: Omit<Account, 'id' | 'createdAt'> & { passwordHash: string }) {
    const email = normalizeEmail(input.email);
    if ([...this.accounts.values()].some((account) => account.email === email)) {
      return Promise.resolve('email-taken' as const);
    }
    const account = { ...input, email, id: uuidv7(), createdAt: new Date() };
    this.accounts.set(account.id, account);
    const { passwordHash: _secret, ...view } = account;
    return Promise.resolve(view);
  }

  findByEmail(email: string) {
    return Promise.resolve(
      [...this.accounts.values()].find((account) => account.email === normalizeEmail(email)) ??
        null,
    );
  }

  findById(id: string) {
    const found = this.accounts.get(id);
    if (!found) return Promise.resolve(null);
    const { passwordHash: _secret, ...account } = found;
    return Promise.resolve(account);
  }

  delete(id: string) {
    this.accounts.delete(id);
    return Promise.resolve();
  }
}

export class MemorySessions implements SessionStore {
  sessions = new Map<string, Session>();
  create(session: Session) {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, session);
    return Promise.resolve(id);
  }
  get(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }
  destroy(id: string) {
    this.sessions.delete(id);
    return Promise.resolve();
  }
  destroyAllOf(userId: string) {
    for (const [id, session] of this.sessions)
      if (session.userId === userId) this.sessions.delete(id);
    return Promise.resolve();
  }
}

export class MemoryGuard implements LoginGuard {
  failures = new Map<string, { count: number; until: number }>();
  lockedFor(email: string, now = Date.now()) {
    const entry = this.failures.get(normalizeEmail(email));
    return Promise.resolve(entry ? Math.max(0, Math.ceil((entry.until - now) / 1000)) : 0);
  }
  failed(email: string, now = Date.now()) {
    const key = normalizeEmail(email);
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    this.failures.set(key, { count, until: now + lockSeconds(count) * 1000 });
    return Promise.resolve();
  }
  succeeded(email: string) {
    this.failures.delete(normalizeEmail(email));
    return Promise.resolve();
  }
}

export class MemoryCarts implements CartStore {
  carts = new Map<string, Cart>();
  get(owner: string) {
    return Promise.resolve(new Map(this.carts.get(owner) ?? []));
  }
  set(owner: string, productId: string, quantity: number) {
    const cart = this.carts.get(owner) ?? new Map<string, number>();
    if (quantity === 0) cart.delete(productId);
    else if (!cart.has(productId) && cart.size >= MAX_LINES)
      return Promise.resolve('too-many-lines' as const);
    else cart.set(productId, quantity);
    this.carts.set(owner, cart);
    return Promise.resolve('ok' as const);
  }
  clear(owner: string) {
    this.carts.delete(owner);
    return Promise.resolve();
  }
  merge(guest: string, account: string) {
    const guestCart = this.carts.get(guest);
    if (guestCart) {
      this.carts.set(
        account,
        mergeCarts(this.carts.get(account) ?? new Map<string, number>(), guestCart),
      );
    }
    this.carts.delete(guest);
    return Promise.resolve();
  }
}

/** Answers the gateway's own calls: catalog lookups and order creation. */
export class FakeInternal implements InternalClient {
  calls: {
    upstream: Upstream;
    actor: Actor;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }[] = [];
  products: Record<string, unknown>[] = [];
  orderStatus = 202;

  call<T>(
    upstream: Upstream,
    actor: Actor,
    request: {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ) {
    this.calls.push({ upstream, actor, ...request });
    if (upstream === 'catalog') {
      const ids = new URL(request.path, 'http://x').searchParams.get('ids')?.split(',') ?? [];
      return Promise.resolve({
        status: 200,
        body: { items: this.products.filter((product) => ids.includes(product.id as string)) },
      } as UpstreamResponse<T>);
    }
    return Promise.resolve({
      status: this.orderStatus,
      body: { id: uuidv7(), status: 'PENDING' },
    } as UpstreamResponse<T>);
  }
}

/** A stand-in for every service: echoes what the gateway forwarded, with the actor of its token. */
export async function echoUpstream(publicKeys: ReturnType<typeof parsePublicKeys>) {
  const upstream: FastifyInstance = Fastify();
  upstream.removeAllContentTypeParsers();
  upstream.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  upstream.all('/*', async (request, reply) => {
    const token = (request.headers.authorization ?? '').replace('Bearer ', '');
    let actor: unknown = null;
    for (const service of ['catalog', 'orders', 'payments', 'notifications']) {
      try {
        actor = {
          service,
          ...(await createInternalVerifier({ audience: service, publicKeys })(token)),
        };
        break;
      } catch {
        // Not for this audience.
      }
    }
    return reply
      .header('set-cookie', 'stolen=1')
      .header('x-upstream', 'echo')
      .send({
        url: request.url,
        method: request.method,
        actor,
        headers: request.headers,
        body: Buffer.isBuffer(request.body) ? request.body.toString('utf8') : null,
      });
  });
  await upstream.listen({ host: '127.0.0.1', port: 0 });
  const address = upstream.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { upstream, url: `http://127.0.0.1:${port}` };
}

/** The gateway on memory stores, with a real signing key and an echo service behind it. */
export async function testGateway(options: { docs?: OpenApiAggregator } = {}) {
  const { privateJwk, publicJwk } = await generateSigningKeys('test');
  const signingKey = await importSigningKey(JSON.stringify(privateJwk));
  const publicKeys = parsePublicKeys(JSON.stringify([publicJwk]));
  const echo = await echoUpstream(publicKeys);
  const deps = {
    accounts: new MemoryAccounts(),
    sessions: new MemorySessions(),
    guard: new MemoryGuard(),
    carts: new MemoryCarts(),
    internal: new FakeInternal(),
  };
  const app = await buildApp({
    logger: createLogger('gateway-test', 'silent'),
    ...deps,
    signingKey,
    upstreams: { catalog: echo.url, orders: echo.url, payments: echo.url, notifications: echo.url },
    publicOrigin: ORIGIN,
    cookieSecure: true,
    sessionDays: 7,
    ...(options.docs ? { docs: options.docs } : {}),
  });
  return {
    app,
    ...deps,
    publicKeys,
    close: async () => Promise.all([app.close(), echo.upstream.close()]),
  };
}
