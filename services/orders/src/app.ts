import { createService, type Logger, type TokenVerifier } from '@soukconnect/service-kit';
import { registerRoutes } from './http/routes.js';
import type { OrderStore } from './ports.js';

export interface AppDeps {
  logger: Logger;
  store: OrderStore;
  verifyToken: TokenVerifier;
  health?: Record<string, () => Promise<unknown>>;
  now?: () => Date;
}

export async function buildApp(deps: AppDeps) {
  const app = await createService({
    name: 'orders',
    logger: deps.logger,
    verifyToken: deps.verifyToken,
    ...(deps.health ? { health: deps.health } : {}),
  });
  registerRoutes(app, deps.store, deps.now);
  return app;
}
