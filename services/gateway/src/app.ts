import swaggerUi from '@fastify/swagger-ui';
import { createService, type Logger, type SigningKey } from '@soukconnect/service-kit';
import type { AccountStore } from './auth/accounts.js';
import type { LoginGuard } from './auth/login-guard.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { SessionStore } from './auth/sessions.js';
import type { CartStore } from './cart/cart-store.js';
import { registerCartRoutes } from './cart/routes.js';
import type { OpenApiAggregator } from './docs/openapi.js';
import { registerContext } from './http/context.js';
import type { InternalClient } from './proxy/internal-client.js';
import { registerProxy } from './proxy/proxy-routes.js';
import type { Upstream } from './proxy/routing.js';
import { registerRealtimeRoutes } from './realtime/routes.js';

export interface GatewayDeps {
  logger: Logger;
  accounts: AccountStore;
  sessions: SessionStore;
  guard: LoginGuard;
  carts: CartStore;
  internal: InternalClient;
  signingKey: SigningKey;
  upstreams: Record<Upstream, string>;
  publicOrigin: string;
  cookieSecure: boolean;
  sessionDays: number;
  trustProxyHops?: number;
  /** ioredis client shared by the replicas for the rate limits. */
  redis?: object;
  docs?: OpenApiAggregator;
  health?: Record<string, () => Promise<unknown>>;
}

/** The only HTTP entry point of the platform (ADR 0006). */
export async function buildApp(deps: GatewayDeps) {
  const app = await createService({
    name: 'gateway',
    logger: deps.logger,
    trustProxyHops: deps.trustProxyHops ?? 0,
    // Per visitor address; sign-in and sign-up have stricter limits of their own.
    rateLimit: { max: 300, timeWindowMs: 60_000, ...(deps.redis ? { redis: deps.redis } : {}) },
    ...(deps.health ? { health: deps.health } : {}),
  });
  await registerContext(app, {
    sessions: deps.sessions,
    publicOrigin: deps.publicOrigin,
    cookieSecure: deps.cookieSecure,
    sessionDays: deps.sessionDays,
  });
  registerAuthRoutes(app, deps);
  registerCartRoutes(app, deps);
  registerRealtimeRoutes(app, deps.signingKey);
  const { docs } = deps;
  if (docs) {
    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      transformSpecification: () => docs.current(),
      staticCSP: true,
    });
  }
  await registerProxy(app, { signingKey: deps.signingKey, upstreams: deps.upstreams });
  return app;
}
