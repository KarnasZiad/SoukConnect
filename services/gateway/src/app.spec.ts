import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, testGateway } from '../test/fakes.js';

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const context = await testGateway();
  close = context.close;
  return context;
}

const productId = '0199f0a4-7a5b-7c1e-9f00-0000000000a1';
const otherProductId = '0199f0a4-7a5b-7c1e-9f00-0000000000a2';
const passphrase = 'tapis de laine du moyen atlas';

/** The cookies a response sets, as a Cookie header for the next request. */
function cookiesOf(response: LightMyRequestResponse, previous = ''): string {
  const jar = new Map(
    previous
      .split('; ')
      .filter(Boolean)
      .map((pair) => pair.split('=', 2) as [string, string]),
  );
  for (const cookie of response.cookies) {
    if (cookie.value === '' || cookie.maxAge === 0) jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

type Gateway = Awaited<ReturnType<typeof setup>>;

function send(
  gateway: Gateway,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  options: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  return gateway.app.inject({
    method,
    url,
    headers: {
      origin: ORIGIN,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

async function register(
  gateway: Gateway,
  role: 'buyer' | 'seller' = 'buyer',
  email = 'amina@example.ma',
  cookie?: string,
) {
  const response = await send(gateway, 'POST', '/api/auth/register', {
    payload: { email, password: passphrase, displayName: 'Amina', role, locale: 'ar' },
    ...(cookie ? { cookie } : {}),
  });
  return { response, cookie: cookiesOf(response, cookie) };
}

describe('accounts (US-14)', () => {
  it('signs up and opens a session in a host-only, HttpOnly, SameSite cookie', async () => {
    const gateway = await setup();
    const { response, cookie } = await register(gateway);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      email: 'amina@example.ma',
      role: 'buyer',
      locale: 'ar',
    });
    expect(response.json()).not.toHaveProperty('passwordHash');
    const session = response.cookies.find((entry) => entry.name === '__Host-souk_session');
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect((await send(gateway, 'GET', '/api/auth/me', { cookie })).json()).toMatchObject({
      displayName: 'Amina',
    });
  });

  it('refuses a taken e-mail, a short password and the moderator role', async () => {
    const gateway = await setup();
    await register(gateway);

    expect((await register(gateway, 'buyer', ' Amina@Example.MA ')).response.statusCode).toBe(409);
    const short = await send(gateway, 'POST', '/api/auth/register', {
      payload: { email: 'b@example.ma', password: 'short', displayName: 'B', role: 'buyer' },
    });
    expect(short.statusCode).toBe(400);
    const moderator = await send(gateway, 'POST', '/api/auth/register', {
      payload: {
        email: 'c@example.ma',
        password: passphrase,
        displayName: 'Mod',
        role: 'moderator',
      },
    });
    expect(moderator.statusCode).toBe(400);
  });

  it('signs in with a new session, and locks the account after repeated failures (S1)', async () => {
    const gateway = await setup();
    const { cookie: first } = await register(gateway);
    const login = (password: string, cookie?: string) =>
      send(gateway, 'POST', '/api/auth/login', {
        payload: { email: 'amina@example.ma', password },
        ...(cookie ? { cookie } : {}),
      });

    const success = await login(passphrase, first);
    expect(success.statusCode).toBe(200);
    // Rotation: the session opened at sign-up is gone.
    expect((await send(gateway, 'GET', '/api/auth/me', { cookie: first })).statusCode).toBe(401);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login('wrong passphrase!')).statusCode).toBe(401);
    }
    const locked = await login(passphrase);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('answers the same for an unknown e-mail and a wrong password', async () => {
    const gateway = await setup();
    await register(gateway);

    const unknown = await send(gateway, 'POST', '/api/auth/login', {
      payload: { email: 'nobody@example.ma', password: passphrase },
    });
    const wrong = await send(gateway, 'POST', '/api/auth/login', {
      payload: { email: 'amina@example.ma', password: 'not the one at all' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('signs out, exports the account and deletes it with the password', async () => {
    const gateway = await setup();
    const { cookie } = await register(gateway);

    const exported = await send(gateway, 'GET', '/api/auth/account/export', { cookie });
    expect(exported.headers['content-disposition']).toContain('attachment');
    expect(exported.json()).toMatchObject({ account: { email: 'amina@example.ma' } });

    expect(
      (
        await send(gateway, 'POST', '/api/auth/account/delete', {
          cookie,
          payload: { password: 'wrong one here' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await send(gateway, 'POST', '/api/auth/account/delete', {
          cookie,
          payload: { password: passphrase },
        })
      ).statusCode,
    ).toBe(204);
    expect((await send(gateway, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
    expect(gateway.accounts.accounts.size).toBe(0);

    const { cookie: again } = await register(gateway, 'buyer', 'other@example.ma');
    const logout = await send(gateway, 'POST', '/api/auth/logout', { cookie: again });
    expect(logout.statusCode).toBe(204);
    expect((await send(gateway, 'GET', '/api/auth/me', { cookie: again })).statusCode).toBe(401);
  });
});

describe('contact details for e-mails', () => {
  it('hands the contact to the notifications service at sign-up, as the new account', async () => {
    const gateway = await setup();
    const { response } = await register(gateway);

    expect(gateway.internal.calls).toContainEqual(
      expect.objectContaining({
        upstream: 'notifications',
        method: 'PUT',
        path: '/contacts/me',
        body: { email: 'amina@example.ma', displayName: 'Amina', locale: 'ar' },
        actor: { userId: response.json<{ id: string }>().id, role: 'buyer', shopId: null },
      }),
    );
  });

  it('still opens the account when the notifications service is down', async () => {
    const gateway = await setup();
    gateway.internal.notificationsStatus = 503;
    expect((await register(gateway)).response.statusCode).toBe(201);
  });

  it('keeps the account while its contact cannot be erased', async () => {
    const gateway = await setup();
    const { cookie } = await register(gateway);
    gateway.internal.notificationsStatus = 503;

    const refused = await send(gateway, 'POST', '/api/auth/account/delete', {
      cookie,
      payload: { password: passphrase },
    });
    expect(refused.statusCode).toBe(503);
    expect(gateway.accounts.accounts.size).toBe(1);

    gateway.internal.notificationsStatus = 204;
    expect(
      (
        await send(gateway, 'POST', '/api/auth/account/delete', {
          cookie,
          payload: { password: passphrase },
        })
      ).statusCode,
    ).toBe(204);
    expect(gateway.internal.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/contacts/me' });
  });
});

describe('CSRF', () => {
  it('refuses a state change from another origin, or without one, except the Stripe webhook', async () => {
    const gateway = await setup();
    const payload = {
      email: 'x@example.ma',
      password: passphrase,
      displayName: 'X',
      role: 'buyer',
    };

    const foreign = await send(gateway, 'POST', '/api/auth/register', {
      payload,
      headers: { origin: 'https://evil.example' },
    });
    const missing = await gateway.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload,
    });
    const webhook = await gateway.app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1' },
      payload: '{}',
    });

    expect(foreign.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(webhook.statusCode).toBe(200);
  });
});

describe('cart (US-04)', () => {
  it('keeps a guest cart in a cookie, shows the catalog view, and merges it at sign-in', async () => {
    const gateway = await setup();
    gateway.internal.products = [
      {
        id: productId,
        slug: 'tapis',
        title: { fr: 'Tapis' },
        price: 450_000,
        stock: 1,
        images: [],
        shop: { slug: 's', name: 'S' },
      },
    ];

    const added = await send(gateway, 'PUT', `/api/cart/items/${productId}`, {
      payload: { quantity: 2 },
    });
    const guest = cookiesOf(added);
    expect(guest).toContain('__Host-souk_cart=');
    expect(added.json()).toMatchObject({
      count: 2,
      subtotal: 900_000,
      ready: false,
      items: [{ productId, quantity: 2, available: false, product: { slug: 'tapis' } }],
    });
    await send(gateway, 'PUT', `/api/cart/items/${otherProductId}`, {
      cookie: guest,
      payload: { quantity: 1 },
    });
    // Withdrawn from sale: the catalog no longer returns it.
    expect((await send(gateway, 'GET', '/api/cart', { cookie: guest })).json()).toMatchObject({
      items: [{ productId }, { productId: otherProductId, product: null, available: false }],
    });

    const { response, cookie } = await register(gateway, 'buyer', 'amina@example.ma', guest);
    expect(response.cookies.find((entry) => entry.name === '__Host-souk_cart')?.value).toBe('');
    const mine = await send(gateway, 'GET', '/api/cart', { cookie });
    expect(mine.json<{ items: unknown[] }>().items).toHaveLength(2);
    const userId = response.json<{ id: string }>().id;
    expect(gateway.carts.carts.get(`user:${userId}`)?.get(productId)).toBe(2);
  });

  it('removes lines and refuses quantities out of bounds', async () => {
    const gateway = await setup();
    const added = await send(gateway, 'PUT', `/api/cart/items/${productId}`, {
      payload: { quantity: 1 },
    });
    const cookie = cookiesOf(added);

    expect(
      (
        await send(gateway, 'PUT', `/api/cart/items/${productId}`, {
          cookie,
          payload: { quantity: 100 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(gateway, 'PUT', '/api/cart/items/not-a-uuid', {
          cookie,
          payload: { quantity: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await send(gateway, 'DELETE', `/api/cart/items/${productId}`, { cookie })).json(),
    ).toMatchObject({ count: 0, ready: false });
    expect((await send(gateway, 'GET', '/api/cart')).json()).toMatchObject({ items: [], count: 0 });
  });

  it('places the order from the kept cart, then empties it (US-05)', async () => {
    const gateway = await setup();
    const { cookie } = await register(gateway);
    await send(gateway, 'PUT', `/api/cart/items/${productId}`, {
      cookie,
      payload: { quantity: 2 },
    });
    const address = {
      fullName: 'Amina',
      line1: '12 Derb',
      city: 'Marrakech',
      postalCode: '40000',
      country: 'MA',
      phone: '+212600000000',
    };

    const noKey = await send(gateway, 'POST', '/api/checkout', {
      cookie,
      payload: { shippingAddress: address },
    });
    expect(noKey.statusCode).toBe(400);
    const placed = await send(gateway, 'POST', '/api/checkout', {
      cookie,
      payload: { shippingAddress: address },
      headers: { 'idempotency-key': 'checkout-0001' },
    });
    expect(placed.statusCode).toBe(202);
    const call = gateway.internal.calls.at(-1);
    expect(call).toMatchObject({
      upstream: 'orders',
      method: 'POST',
      path: '/orders',
      body: { items: [{ productId, quantity: 2 }], shippingAddress: address },
      headers: { 'idempotency-key': 'checkout-0001' },
      actor: { role: 'buyer' },
    });
    expect((await send(gateway, 'GET', '/api/cart', { cookie })).json()).toMatchObject({
      count: 0,
    });
    expect(
      (
        await send(gateway, 'POST', '/api/checkout', {
          cookie,
          payload: { shippingAddress: address },
          headers: { 'idempotency-key': 'checkout-0002' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('keeps the cart when the order is refused, and lets buyers only check out', async () => {
    const gateway = await setup();
    const { cookie } = await register(gateway, 'seller', 'seller@example.ma');
    expect(
      (
        await send(gateway, 'POST', '/api/checkout', {
          cookie,
          payload: { shippingAddress: {} },
          headers: { 'idempotency-key': 'checkout-0003' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(gateway, 'POST', '/api/checkout', {
          payload: { shippingAddress: {} },
          headers: { 'idempotency-key': 'checkout-0004' },
        })
      ).statusCode,
    ).toBe(401);

    const { cookie: buyer } = await register(gateway, 'buyer', 'buyer@example.ma');
    await send(gateway, 'PUT', `/api/cart/items/${productId}`, {
      cookie: buyer,
      payload: { quantity: 1 },
    });
    gateway.internal.orderStatus = 429;
    const refused = await send(gateway, 'POST', '/api/checkout', {
      cookie: buyer,
      payload: { shippingAddress: {} },
      headers: { 'idempotency-key': 'checkout-0005' },
    });
    expect(refused.statusCode).toBe(429);
    expect((await send(gateway, 'GET', '/api/cart', { cookie: buyer })).json()).toMatchObject({
      count: 1,
    });
  });
});

describe('routing to the services (ADR 0006)', () => {
  it('forwards a visitor with a token for the right service, and never the cookies', async () => {
    const gateway = await setup();

    const response = await send(
      gateway,
      'GET',
      '/api/products/tapis-beni-ouarain-1a2b3c?locale=ar',
      {
        cookie: 'tracking=1',
        headers: { authorization: 'Bearer forged', 'x-user-id': 'admin' },
      },
    );
    const echoed = response.json<{
      url: string;
      actor: unknown;
      headers: Record<string, string>;
    }>();

    expect(echoed.url).toBe('/products/tapis-beni-ouarain-1a2b3c?locale=ar');
    expect(echoed.actor).toEqual({
      service: 'catalog',
      userId: null,
      role: 'visitor',
      shopId: null,
    });
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers['x-user-id']).toBeUndefined();
    expect(echoed.headers['x-request-id']).toBeDefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-upstream']).toBe('echo');
  });

  it('acts for the seller of the session, its shop being its account', async () => {
    const gateway = await setup();
    const { response, cookie } = await register(gateway, 'seller', 'fatima@example.ma');
    const sellerId = response.json<{ id: string }>().id;

    const echoed = (await send(gateway, 'GET', '/api/seller/orders', { cookie })).json<{
      actor: unknown;
    }>();
    expect(echoed.actor).toEqual({
      service: 'orders',
      userId: sellerId,
      role: 'seller',
      shopId: sellerId,
    });
    const balance = (await send(gateway, 'GET', '/api/seller/balance', { cookie })).json<{
      actor: { service: string };
    }>();
    expect(balance.actor.service).toBe('payments');
  });

  it('passes the Stripe webhook body byte for byte, with its signature', async () => {
    const gateway = await setup();
    const raw = '{"id":"evt_1",  "type":"payment_intent.succeeded"}';

    const echoed = (
      await gateway.app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
        payload: raw,
      })
    ).json<{ body: string; headers: Record<string, string>; actor: { service: string } }>();

    expect(echoed.body).toBe(raw);
    expect(echoed.headers['stripe-signature']).toBe('t=1,v1=abc');
    expect(echoed.actor.service).toBe('payments');
  });

  it('answers 404 for paths no service exposes', async () => {
    const gateway = await setup();
    for (const url of ['/api/admin', '/api/health/live', '/api/products/..%2f..%2finternal']) {
      expect((await send(gateway, 'GET', url)).statusCode).toBe(404);
    }
  });
});

describe('realtime ticket', () => {
  it('signs a one-minute ticket for the notifications service', async () => {
    const gateway = await setup();
    expect((await send(gateway, 'POST', '/api/realtime/ticket')).statusCode).toBe(401);
    const { cookie } = await register(gateway);

    const ticket = await send(gateway, 'POST', '/api/realtime/ticket', { cookie });
    expect(ticket.json()).toMatchObject({ expiresIn: 60 });
    const { createInternalVerifier } = await import('@soukconnect/service-kit');
    await expect(
      createInternalVerifier({ audience: 'notifications', publicKeys: gateway.publicKeys })(
        ticket.json<{ ticket: string }>().ticket,
      ),
    ).resolves.toMatchObject({ role: 'buyer' });
  });
});

describe('API documentation', () => {
  it('serves the aggregated document of the public API', async () => {
    const { OpenApiAggregator } = await import('./docs/openapi.js');
    const docs = new OpenApiAggregator(
      () => ({
        openapi: '3.1.0',
        info: { title: 'gateway', version: '0.1.0' },
        paths: { '/api/cart': {} },
      }),
      () =>
        Promise.resolve({
          openapi: '3.1.0',
          info: { title: 'catalog', version: '1' },
          paths: { '/search': { get: {} } },
        }),
      '__Host-souk_session',
    );
    await docs.refresh();
    const context = await testGateway({ docs });
    close = context.close;

    const document = await context.app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(document.statusCode).toBe(200);
    expect(Object.keys(document.json<{ paths: object }>().paths)).toEqual([
      '/api/cart',
      '/api/search',
    ]);
  });
});
