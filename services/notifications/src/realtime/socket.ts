import type { Server as HttpServer } from 'node:http';
import type { Logger, TokenVerifier } from '@soukconnect/service-kit';
import { Server, type ServerOptions } from 'socket.io';
import type { Push } from '../ports.js';

export const roomOf = (userId: string): string => `user:${userId}`;

/**
 * Socket.io on the HTTP server of the service. A client connects with the one-minute ticket of
 * the gateway (ADR 0006) and joins the room of its account; every tab of a person gets its
 * events, on whichever replica it is connected (Redis adapter in production).
 */
export function startRealtime(
  server: HttpServer,
  options: {
    verifyTicket: TokenVerifier;
    logger: Logger;
    publicOrigin: string;
    adapter?: ServerOptions['adapter'];
  },
): { io: Server; push: Push } {
  const io = new Server(server, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: options.publicOrigin },
    ...(options.adapter ? { adapter: options.adapter } : {}),
  });

  io.use((socket, next) => {
    const ticket: unknown = (socket.handshake.auth as Record<string, unknown>).ticket;
    if (typeof ticket !== 'string') {
      next(new Error('A ticket is required'));
      return;
    }
    options.verifyTicket(ticket).then(
      (actor) => {
        if (actor.userId === null) {
          next(new Error('Sign in first'));
          return;
        }
        (socket.data as { userId?: string }).userId = actor.userId;
        next();
      },
      () => {
        next(new Error('Invalid or expired ticket'));
      },
    );
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data as { userId: string };
    void socket.join(roomOf(userId));
    options.logger.info({ userId }, 'socket connected');
  });

  return {
    io,
    push: {
      toUser(userId, event, payload) {
        io.to(roomOf(userId)).emit(event, payload);
      },
    },
  };
}
