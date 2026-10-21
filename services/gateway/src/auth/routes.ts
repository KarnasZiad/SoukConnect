import { LOCALES } from '@soukconnect/contracts';
import { conflict, type createService, ProblemError, unauthorized } from '@soukconnect/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CartStore } from '../cart/cart-store.js';
import type { InternalClient } from '../proxy/internal-client.js';
import { actorOf, requireSession } from '../http/context.js';
import type { Account, AccountStore } from './accounts.js';
import type { LoginGuard } from './login-guard.js';
import { hashPassword, verifyPassword } from './passwords.js';
import type { SessionStore } from './sessions.js';

type App = Awaited<ReturnType<typeof createService>>;

export interface AuthDeps {
  accounts: AccountStore;
  sessions: SessionStore;
  guard: LoginGuard;
  carts: CartStore;
  internal: InternalClient;
}

// Pasted addresses often carry spaces or capitals: one person, one account.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Long passphrases rather than complex rules (NIST SP 800-63B); bounded to keep hashing cheap. */
const password = z.string().min(12).max(128);

const accountView = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['buyer', 'seller', 'moderator']),
  locale: z.enum(LOCALES),
  createdAt: z.iso.datetime(),
});

const toView = (account: Account): z.infer<typeof accountView> => ({
  ...account,
  createdAt: account.createdAt.toISOString(),
});

const INVALID = 'Invalid e-mail or password';

export function registerAuthRoutes(app: App, deps: AuthDeps): void {
  /** Opens a session for the account (rotating any previous one) and brings the guest cart along. */
  async function signIn(request: FastifyRequest, reply: FastifyReply, account: Account) {
    if (request.session) await deps.sessions.destroy(request.session.id);
    reply.startSession(
      await deps.sessions.create({ userId: account.id, role: account.role, createdAt: Date.now() }),
    );
    const guest = request.guestCart();
    if (guest) {
      await deps.carts.merge(guest, `user:${account.id}`);
      reply.endGuestCart();
    }
  }

  app.post(
    '/api/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        body: z
          .object({
            email,
            password,
            displayName: z.string().trim().min(2).max(60),
            // Moderators are created by the operators, never by sign-up (E1).
            role: z.enum(['buyer', 'seller']),
            locale: z.enum(LOCALES).default('fr'),
          })
          .strict(),
        response: { 201: accountView },
      },
    },
    async (request, reply) => {
      const { password: secret, ...profile } = request.body;
      const account = await deps.accounts.create({
        ...profile,
        passwordHash: await hashPassword(secret),
      });
      if (account === 'email-taken') throw conflict('An account already uses this e-mail');
      await signIn(request, reply, account);
      // The notifications service keeps the contact it needs to send e-mails. Best effort: the
      // account exists either way, and the contact is written again at the next sign-up attempt.
      try {
        const saved = await deps.internal.call(
          'notifications',
          actorOf({ userId: account.id, role: account.role, createdAt: 0 }),
          {
            method: 'PUT',
            path: '/contacts/me',
            body: {
              email: account.email,
              displayName: account.displayName,
              locale: account.locale,
            },
            requestId: request.id,
          },
        );
        if (saved.status !== 204) request.log.warn({ status: saved.status }, 'contact not saved');
      } catch (error) {
        request.log.warn({ err: error }, 'contact not saved');
      }
      return reply.code(201).send(toView(account));
    },
  );

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        body: z.object({ email, password: z.string().min(1).max(128) }).strict(),
        response: { 200: accountView },
      },
    },
    async (request, reply) => {
      const wait = await deps.guard.lockedFor(request.body.email);
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new ProblemError(
          429,
          'Too Many Requests',
          'Too many failed attempts, try again later',
        );
      }
      const found = await deps.accounts.findByEmail(request.body.email);
      // The same answer, after the same work, whether the e-mail exists or not.
      const valid = await verifyPassword(found?.passwordHash ?? null, request.body.password);
      if (!found || !valid) {
        await deps.guard.failed(request.body.email);
        throw new ProblemError(401, 'Unauthorized', INVALID);
      }
      await deps.guard.succeeded(request.body.email);
      const { passwordHash: _secret, ...account } = found;
      await signIn(request, reply, account);
      return toView(account);
    },
  );

  app.post('/api/auth/logout', { schema: { tags: ['auth'] } }, async (request, reply) => {
    if (request.session) await deps.sessions.destroy(request.session.id);
    reply.endSession();
    return reply.code(204).send();
  });

  app.get(
    '/api/auth/me',
    { schema: { tags: ['auth'], response: { 200: accountView } } },
    async (request) => {
      const account = await deps.accounts.findById(requireSession(request).userId);
      if (!account) throw unauthorized();
      return toView(account);
    },
  );

  // Loi 09-08 and GDPR: a copy of the data, and its erasure.
  app.get('/api/auth/account/export', { schema: { tags: ['auth'] } }, async (request, reply) => {
    const account = await deps.accounts.findById(requireSession(request).userId);
    if (!account) throw unauthorized();
    return reply
      .header('content-disposition', 'attachment; filename="soukconnect-account.json"')
      .send({ account: toView(account), exportedAt: new Date().toISOString() });
  });

  app.post(
    '/api/auth/account/delete',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], body: z.object({ password: z.string().min(1).max(128) }).strict() },
    },
    async (request, reply) => {
      const session = requireSession(request);
      const account = await deps.accounts.findById(session.userId);
      const found = account ? await deps.accounts.findByEmail(account.email) : null;
      if (!found || !(await verifyPassword(found.passwordHash, request.body.password))) {
        throw new ProblemError(401, 'Unauthorized', INVALID);
      }
      // The copy of the contact goes first: no account is erased while its e-mail survives elsewhere.
      const erased = await deps.internal
        .call('notifications', actorOf(session), {
          method: 'DELETE',
          path: '/contacts/me',
          requestId: request.id,
        })
        .catch(() => null);
      if (erased?.status !== 204) {
        throw new ProblemError(
          503,
          'Service Unavailable',
          'The account cannot be deleted right now',
        );
      }
      await deps.accounts.delete(session.userId);
      await deps.sessions.destroyAllOf(session.userId);
      await deps.carts.clear(`user:${session.userId}`);
      reply.endSession();
      return reply.code(204).send();
    },
  );
}
