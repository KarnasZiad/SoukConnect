import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import type { Role } from '@soukconnect/contracts';
import Fastify, { type FastifyRequest, LogController } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Actor, TokenVerifier } from './internal-auth.js';
import { forbidden, ProblemError, sendProblem, unauthorized } from './problem.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set from the internal token of the gateway; null on public routes. */
    actor: Actor | null;
  }
  interface FastifyContextConfig {
    /** Reachable without an internal token: health checks and the OpenAPI document only. */
    public?: boolean;
  }
}

export interface ServiceOptions {
  name: string;
  version?: string;
  logger: Logger;
  /**
   * Verifies the internal token of every request. Omitted only by the gateway, which faces the
   * browser and authenticates with sessions instead.
   */
  verifyToken?: TokenVerifier;
  /** Readiness checks: each one throws when its dependency is unavailable. */
  health?: Record<string, () => Promise<unknown>>;
  bodyLimit?: number;
  /** Number of proxies in front of the service whose X-Forwarded-For can be trusted. */
  trustProxyHops?: number;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** Keeps the identifier the gateway assigned, so that one request is traceable across services. */
function requestIdOf(request: { headers: Record<string, unknown> }): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

/**
 * A Fastify instance with the conventions shared by every service: Zod validation and OpenAPI
 * 3.1 generated from the same schemas, internal token verification, problem+json errors,
 * health endpoints and correlated logs.
 */
export async function createService(options: ServiceOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    genReqId: requestIdOf,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    bodyLimit: options.bodyLimit ?? 64 * 1024,
    trustProxy: (_address: string, hop: number) => hop < (options.trustProxyHops ?? 0),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // An API returns JSON only: no content security policy needed, the other headers still apply.
  await app.register(helmet, { contentSecurityPolicy: false, global: true });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: options.name, version: options.version ?? '0.1.0' },
      components: {
        securitySchemes: {
          internalToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ internalToken: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.decorateRequest('actor', null);
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  const { verifyToken } = options;
  if (verifyToken) {
    app.addHook('onRequest', async (request) => {
      if (request.routeOptions.config.public === true) return;
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw unauthorized();
      try {
        request.actor = await verifyToken(header.slice('Bearer '.length));
      } catch (error) {
        request.log.warn({ err: error }, 'internal token refused');
        throw unauthorized();
      }
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      return sendProblem(reply, error.status, error.title, {
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...error.extra,
      });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendProblem(reply, 400, 'Bad Request', {
        errors: error.validation.map((issue) => ({
          path: issue.instancePath,
          message: issue.message,
        })),
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return sendProblem(reply, status, (error as Error).message);
    request.log.error({ err: error }, 'request failed');
    return sendProblem(reply, 500, 'Internal Server Error');
  });
  app.setNotFoundHandler((_request, reply) => sendProblem(reply, 404, 'Not Found'));

  app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, () =>
    app.swagger(),
  );
  app.get('/health/live', { config: { public: true }, schema: { hide: true } }, () => ({
    status: 'up',
  }));
  app.get(
    '/health/ready',
    { config: { public: true }, schema: { hide: true } },
    async (_request, reply) => {
      const entries = await Promise.all(
        Object.entries(options.health ?? {}).map(async ([name, check]) => {
          try {
            await check();
            return [name, 'up'] as const;
          } catch {
            return [name, 'down'] as const;
          }
        }),
      );
      const up = entries.every(([, status]) => status === 'up');
      return reply
        .code(up ? 200 : 503)
        .send({ status: up ? 'up' : 'down', dependencies: Object.fromEntries(entries) });
    },
  );

  return app;
}

/**
 * The signed-in actor of a request, with one of the given roles (any role when none is given).
 * A visitor gets 401; a signed-in actor without the role gets 403.
 */
export function requireUser(
  request: FastifyRequest,
  ...roles: Role[]
): Actor & { userId: string; role: Role } {
  const actor = request.actor;
  if (actor?.userId == null || actor.role === 'visitor') throw unauthorized();
  if (roles.length > 0 && !roles.includes(actor.role)) throw forbidden();
  return { ...actor, userId: actor.userId, role: actor.role };
}

/** The shop a seller acts for; 403 for anyone else. */
export function requireShop(request: FastifyRequest): string {
  const actor = requireUser(request, 'seller');
  if (actor.shopId === null) throw forbidden('This account has no shop yet');
  return actor.shopId;
}
