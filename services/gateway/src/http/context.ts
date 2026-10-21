import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import {
  type Actor,
  type createService,
  ProblemError,
  unauthorized,
} from '@soukconnect/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { digest, type Session, type SessionStore } from '../auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: (Session & { id: string }) | null;
  }
}

export interface ContextOptions {
  sessions: SessionStore;
  /** Origin of the front, e.g. https://soukconnect.ma. */
  publicOrigin: string;
  cookieSecure: boolean;
  sessionDays: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Stripe calls this one from its servers: no browser, no Origin; the signature protects it. */
const ORIGINLESS = new Set(['/api/webhooks/stripe']);
const CART_DAYS = 30;

export function cookieNames(secure: boolean) {
  // __Host-: Secure, Path=/ and no Domain, so a subdomain cannot plant or read the cookie.
  return secure
    ? { session: '__Host-souk_session', cart: '__Host-souk_cart' }
    : { session: 'souk_session', cart: 'souk_cart' };
}

/** Who the services see: a visitor, or the account of the session (a seller acts for its shop). */
export function actorOf(session: Session | null): Actor {
  if (!session) return { userId: null, role: 'visitor', shopId: null };
  return {
    userId: session.userId,
    role: session.role,
    shopId: session.role === 'seller' ? session.userId : null,
  };
}

export function requireSession(request: FastifyRequest): Session & { id: string } {
  if (!request.session) throw unauthorized();
  return request.session;
}

type App = Awaited<ReturnType<typeof createService>>;

export async function registerContext(app: App, options: ContextOptions): Promise<void> {
  const names = cookieNames(options.cookieSecure);
  await app.register(cookie);
  app.decorateRequest('session', null);

  // preParsing: after the rate limit (route-level onRequest), before the body is read.
  app.addHook('preParsing', async (request, _reply, payload) => {
    // CSRF: SameSite=Lax already keeps the cookie off cross-site writes; the Origin is checked too.
    const path = request.url.split('?')[0] ?? '';
    if (!SAFE_METHODS.has(request.method) && !ORIGINLESS.has(path)) {
      if (request.headers.origin !== options.publicOrigin) {
        throw new ProblemError(403, 'Forbidden', 'Cross-origin request');
      }
    }
    const id = request.cookies[names.session];
    if (id) {
      const session = await options.sessions.get(id);
      request.session = session ? { ...session, id } : null;
    }
    return payload;
  });

  const cookieOptions = {
    httpOnly: true,
    secure: options.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };

  app.decorateReply('startSession', function (this: FastifyReply, id: string) {
    void this.setCookie(names.session, id, {
      ...cookieOptions,
      maxAge: options.sessionDays * 86_400,
    });
  });
  app.decorateReply('endSession', function (this: FastifyReply) {
    void this.clearCookie(names.session, cookieOptions);
  });
  app.decorateReply('endGuestCart', function (this: FastifyReply) {
    void this.clearCookie(names.cart, cookieOptions);
  });
  app.decorateRequest('guestCart', function (this: FastifyRequest) {
    const value = this.cookies[names.cart];
    return value && /^[A-Za-z0-9_-]{22}$/.test(value) ? `guest:${digest(value)}` : null;
  });
  app.decorateReply('newGuestCart', function (this: FastifyReply) {
    const value = randomBytes(16).toString('base64url');
    void this.setCookie(names.cart, value, { ...cookieOptions, maxAge: CART_DAYS * 86_400 });
    return `guest:${digest(value)}`;
  });
}

declare module 'fastify' {
  interface FastifyReply {
    startSession(id: string): void;
    endSession(): void;
    endGuestCart(): void;
    /** Opens a guest cart and returns its owner key. */
    newGuestCart(): string;
  }
  interface FastifyRequest {
    /** Owner key of the guest cart of the cookie, if any. */
    guestCart(): string | null;
  }
}
