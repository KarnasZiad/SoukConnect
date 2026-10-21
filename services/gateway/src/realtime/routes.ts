import { type createService, signInternalToken, type SigningKey } from '@soukconnect/service-kit';
import { z } from 'zod';
import { actorOf, requireSession } from '../http/context.js';

type App = Awaited<ReturnType<typeof createService>>;

const TICKET_SECONDS = 60;

/**
 * A ticket for the Socket.io connection of the notifications service (ADR 0006): the same signed
 * token as the services get, for the notifications audience, valid one minute.
 */
export function registerRealtimeRoutes(app: App, signingKey: SigningKey): void {
  app.post(
    '/api/realtime/ticket',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['realtime'],
        response: { 200: z.object({ ticket: z.string(), expiresIn: z.int() }) },
      },
    },
    async (request) => {
      const session = requireSession(request);
      return {
        ticket: await signInternalToken(
          signingKey,
          'notifications',
          actorOf(session),
          TICKET_SECONDS,
        ),
        expiresIn: TICKET_SECONDS,
      };
    },
  );
}
