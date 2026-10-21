import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createInternalVerifier,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
  signInternalToken,
} from './internal-auth.js';
import { loggerOptions } from './logger.js';
import { conflict, notFound } from './problem.js';
import { createService, requireShop, requireUser } from './service.js';

const buyer = {
  userId: '0199f0a4-7a5b-7c1e-9f00-0000000000b1',
  role: 'buyer' as const,
  shopId: null,
};
const seller = {
  userId: '0199f0a4-7a5b-7c1e-9f00-0000000000c1',
  role: 'seller' as const,
  shopId: '0199f0a4-7a5b-7c1e-9f00-0000000000c2',
};

/** A logger that writes into an array, to check what reaches the logs. */
function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { logger: pino(loggerOptions('test', 'info'), stream), lines };
}

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function service(health: Record<string, () => Promise<unknown>> = {}) {
  const { privateJwk, publicJwk } = await generateSigningKeys('k1');
  const signing = await importSigningKey(JSON.stringify(privateJwk));
  const { logger, lines } = memoryLogger();
  const app = await createService({
    name: 'orders',
    logger,
    health,
    verifyToken: createInternalVerifier({
      audience: 'orders',
      publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
    }),
  });
  app.get('/whoami', (request) => ({ actor: request.actor }));
  app.get('/mine', (request) => requireUser(request, 'buyer'));
  app.get('/shop', (request) => ({ shopId: requireShop(request) }));
  app.post(
    '/orders',
    {
      schema: {
        body: z.object({ quantity: z.int().min(1) }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (_request, reply) => reply.code(201).send({ id: 'o-1' }),
  );
  app.get('/missing', () => {
    throw notFound('No such order');
  });
  app.get('/taken', () => {
    throw conflict('Already paid', { orderId: 'o-1' });
  });
  app.get('/crash', () => {
    throw new Error('connection string postgres://user:secret@db leaked');
  });
  apps.push(app);
  const token = (actor: Parameters<typeof signInternalToken>[2], audience = 'orders') =>
    signInternalToken(signing, audience, actor);
  return { app, lines, token };
}

describe('createService', () => {
  it('refuses any request without a valid internal token', async () => {
    const { app, token } = await service();

    const missing = await app.inject({ url: '/whoami' });
    const forged = await app.inject({
      url: '/whoami',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    const otherService = await app.inject({
      url: '/whoami',
      headers: { authorization: `Bearer ${await token(buyer, 'catalog')}` },
    });

    for (const response of [missing, forged, otherService]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('exposes the actor of a valid token to the routes', async () => {
    const { app, token } = await service();
    const response = await app.inject({
      url: '/whoami',
      headers: { authorization: `Bearer ${await token(seller)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: seller });
  });

  it('checks roles and shops', async () => {
    const { app, token } = await service();
    const as = async (actor: Parameters<typeof token>[0], url: string) =>
      (await app.inject({ url, headers: { authorization: `Bearer ${await token(actor)}` } }))
        .statusCode;

    expect(await as(buyer, '/mine')).toBe(200);
    expect(await as(seller, '/mine')).toBe(403);
    expect(await as({ userId: null, role: 'visitor', shopId: null }, '/mine')).toBe(401);
    expect(await as(seller, '/shop')).toBe(200);
    expect(await as({ ...seller, shopId: null }, '/shop')).toBe(403);
    expect(await as(buyer, '/shop')).toBe(403);
  });

  it('answers validation errors, problems and crashes as problem documents', async () => {
    const { app, token, lines } = await service();
    const headers = { authorization: `Bearer ${await token(buyer)}` };

    const invalid = await app.inject({
      method: 'POST',
      url: '/orders',
      headers,
      payload: { quantity: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ title: 'Bad Request', errors: [{ path: '/quantity' }] });

    expect((await app.inject({ url: '/missing', headers })).json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No such order',
    });
    expect((await app.inject({ url: '/taken', headers })).json()).toMatchObject({
      status: 409,
      orderId: 'o-1',
    });

    const crash = await app.inject({ url: '/crash', headers });
    expect(crash.statusCode).toBe(500);
    expect(crash.body).not.toContain('secret');
    expect(lines.some((line) => line.msg === 'request failed')).toBe(true);

    expect((await app.inject({ url: '/nowhere', headers })).statusCode).toBe(404);
  });

  it('keeps the request id of the gateway, and makes one up otherwise', async () => {
    const { app, token } = await service();
    const headers = { authorization: `Bearer ${await token(buyer)}` };

    const kept = await app.inject({
      url: '/whoami',
      headers: { ...headers, 'x-request-id': 'req-12345678' },
    });
    const invented = await app.inject({
      url: '/whoami',
      headers: { ...headers, 'x-request-id': '<script>' },
    });

    expect(kept.headers['x-request-id']).toBe('req-12345678');
    expect(invented.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never logs the internal token', async () => {
    const { app, token, lines } = await service();
    const secretToken = await token(buyer);
    await app.inject({ url: '/whoami', headers: { authorization: `Bearer ${secretToken}` } });

    expect(JSON.stringify(lines)).not.toContain(secretToken);
  });

  it('serves health checks and the OpenAPI document without a token', async () => {
    const { app } = await service({
      mongo: () => Promise.resolve(),
      broker: () => Promise.reject(new Error('down')),
    });

    expect((await app.inject({ url: '/health/live' })).json()).toEqual({ status: 'up' });
    const ready = await app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'down', dependencies: { mongo: 'up', broker: 'down' } });

    await app.ready();
    const openapi = await app.inject({ url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    const document = openapi.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/orders');
    expect(Object.keys(document.paths)).not.toContain('/health/live');
  });

  it('is ready when every dependency answers', async () => {
    const { app } = await service({ mongo: () => Promise.resolve() });
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
  });
});

describe('createService without token verification (gateway)', () => {
  it('lets requests through with no actor', async () => {
    const { logger } = memoryLogger();
    const app = await createService({ name: 'gateway', logger });
    app.get('/public', (request) => ({ actor: request.actor }));
    apps.push(app);

    expect((await app.inject({ url: '/public' })).json()).toEqual({ actor: null });
  });
});
