import { createService, type Logger, type TokenVerifier } from '@soukconnect/service-kit';
import { registerRoutes, type RouteDeps } from './http/routes.js';

export interface AppDeps extends RouteDeps {
  logger: Logger;
  verifyToken: TokenVerifier;
  health?: Record<string, () => Promise<unknown>>;
}

export async function buildApp(deps: AppDeps) {
  const app = await createService({
    name: 'payments',
    logger: deps.logger,
    verifyToken: deps.verifyToken,
    ...(deps.health ? { health: deps.health } : {}),
  });
  registerRoutes(app, deps);
  return app;
}
