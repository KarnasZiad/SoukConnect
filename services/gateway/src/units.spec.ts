import { describe, expect, it } from 'vitest';
import { lockSeconds } from './auth/login-guard.js';
import { MAX_LINES, MAX_QUANTITY, mergeCarts } from './cart/cart-store.js';
import { mergeDocuments, OpenApiAggregator } from './docs/openapi.js';
import { downstreamHeaders, resolveUpstream, upstreamHeaders } from './proxy/routing.js';

describe('routing table', () => {
  it.each([
    ['/products/tapis-beni-ouarain-1a2b3c', 'catalog'],
    ['/products', 'catalog'],
    ['/search', 'catalog'],
    ['/shops/atelier-fatima', 'catalog'],
    ['/seller/shop', 'catalog'],
    ['/seller/products/0199f0a4/status', 'catalog'],
    ['/moderation/shops/0199/status', 'catalog'],
    ['/orders', 'orders'],
    ['/orders/0199f0a4/cancel', 'orders'],
    ['/seller/orders', 'orders'],
    ['/seller/stats', 'orders'],
    ['/orders/0199f0a4/payment', 'payments'],
    ['/seller/balance', 'payments'],
    ['/webhooks/stripe', 'payments'],
    ['/conversations/42/messages', 'notifications'],
  ])('sends %s to %s', (path, upstream) => {
    expect(resolveUpstream(path)).toBe(upstream);
  });

  it('refuses unknown paths, traversal and encoded separators', () => {
    for (const path of [
      '/admin',
      '/health/live',
      '/openapi.json',
      '/products/../internal',
      '/products/%2e%2e/x',
      '/products//x',
      '/seller/../orders',
      '',
    ]) {
      expect(resolveUpstream(path)).toBeNull();
    }
  });

  it('forwards only the allowed request headers, with the internal token', () => {
    expect(
      upstreamHeaders(
        {
          cookie: 'souk_session=abc',
          authorization: 'Bearer forged',
          'x-user-id': 'someone',
          'Content-Type': 'application/json',
          'idempotency-key': 'k-12345678',
          'stripe-signature': 't=1,v1=x',
          'accept-language': ['fr', 'ar'],
        },
        { token: 'signed', requestId: 'req-12345678' },
      ),
    ).toEqual({
      'content-type': 'application/json',
      'idempotency-key': 'k-12345678',
      'stripe-signature': 't=1,v1=x',
      authorization: 'Bearer signed',
      'x-request-id': 'req-12345678',
    });
    expect(
      downstreamHeaders({ 'set-cookie': 'x=1', server: 'nginx', 'content-type': 'json' }),
    ).toEqual({
      'content-type': 'json',
    });
  });
});

describe('login lock', () => {
  it('waits one minute after five failures, doubling up to an hour', () => {
    expect([1, 4, 5, 6, 7, 10, 20].map(lockSeconds)).toEqual([0, 0, 60, 120, 240, 1920, 3600]);
  });
});

describe('cart merge (US-04)', () => {
  it('adds the guest quantities to the account, within the limits of an order', () => {
    expect(
      mergeCarts(
        new Map([
          ['a', 2],
          ['b', 98],
        ]),
        new Map([
          ['b', 5],
          ['c', 1],
        ]),
      ),
    ).toEqual(
      new Map([
        ['a', 2],
        ['b', MAX_QUANTITY],
        ['c', 1],
      ]),
    );
  });

  it('keeps the account lines first when the merge would exceed the number of lines', () => {
    const full = new Map(Array.from({ length: MAX_LINES }, (_, index) => [`p${index}`, 1]));
    const merged = mergeCarts(
      full,
      new Map([
        ['extra', 1],
        ['p0', 1],
      ]),
    );
    expect(merged.size).toBe(MAX_LINES);
    expect(merged.get('p0')).toBe(2);
    expect(merged.has('extra')).toBe(false);
  });
});

describe('aggregated OpenAPI document', () => {
  it('publishes the routes the gateway exposes, under /api, with the session cookie', () => {
    const document = mergeDocuments(
      {
        openapi: '3.1.0',
        info: { title: 'gateway', version: '0.1.0' },
        paths: { '/api/cart': { get: {} }, '/health/live': { get: {} } },
      },
      {
        catalog: {
          openapi: '3.1.0',
          info: { title: 'catalog', version: '0.1.0' },
          paths: {
            '/products/{slug}': { get: {} },
            '/search': { get: {} },
            '/internal': { get: {} },
          },
          components: { schemas: { Product: { type: 'object' } } },
        },
        payments: {
          openapi: '3.1.0',
          info: { title: 'payments', version: '0.1.0' },
          paths: { '/orders/{orderId}/payment': { get: {} }, '/webhooks/stripe': { post: {} } },
        },
      },
      '__Host-souk_session',
    );

    expect(Object.keys(document.paths)).toEqual([
      '/api/cart',
      '/api/orders/{orderId}/payment',
      '/api/products/{slug}',
      '/api/search',
      '/api/webhooks/stripe',
    ]);
    expect(document.components?.schemas).toEqual({ Product: { type: 'object' } });
    expect(document.components?.securitySchemes).toEqual({
      session: { type: 'apiKey', in: 'cookie', name: '__Host-souk_session' },
    });
  });
});

describe('OpenAPI aggregator', () => {
  const own = () => ({
    openapi: '3.1.0',
    info: { title: 'gateway', version: '0.1.0' },
    paths: { '/api/cart': { get: {} } },
  });

  it('keeps the paths of a service that stops answering', async () => {
    let up = true;
    const aggregator = new OpenApiAggregator(
      own,
      (upstream) =>
        upstream === 'catalog' && up
          ? Promise.resolve({
              openapi: '3.1.0',
              info: { title: 'catalog', version: '1' },
              paths: { '/search': { get: {} } },
            })
          : Promise.reject(new Error('unavailable')),
      'souk_session',
    );

    expect(Object.keys(aggregator.current().paths)).toEqual(['/api/cart']);
    await aggregator.refresh();
    up = false;
    await aggregator.refresh();
    expect(Object.keys(aggregator.current().paths)).toEqual(['/api/cart', '/api/search']);
  });
});
