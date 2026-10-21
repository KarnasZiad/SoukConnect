import replyFrom from '@fastify/reply-from';
import {
  type createService,
  notFound,
  signInternalToken,
  type SigningKey,
} from '@soukconnect/service-kit';
import { actorOf } from '../http/context.js';
import { downstreamHeaders, resolveUpstream, type Upstream, upstreamHeaders } from './routing.js';

export interface ProxyDeps {
  signingKey: SigningKey;
  upstreams: Record<Upstream, string>;
}

type App = Awaited<ReturnType<typeof createService>>;

/**
 * Every other `/api/*` request goes to the service of its path, with a token signed for that
 * service and the identity of the session. The body is forwarded byte for byte: the Stripe
 * signature covers it.
 */
export async function registerProxy(app: App, deps: ProxyDeps): Promise<void> {
  await app.register(async (scope) => {
    await scope.register(replyFrom, { undici: { headersTimeout: 10_000, bodyTimeout: 30_000 } });
    // Bodies stay unparsed text: reply-from sends a string as is (it would re-serialize a parsed
    // object or a Buffer), so the bytes signed by Stripe reach payments unchanged.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    scope.all(
      '/api/*',
      { schema: { hide: true }, bodyLimit: 512 * 1024 },
      async (request, reply) => {
        const [path = '', query] = request.url.slice('/api'.length).split('?', 2);
        const upstream = resolveUpstream(path);
        if (!upstream) throw notFound();
        const token = await signInternalToken(deps.signingKey, upstream, actorOf(request.session));
        // With an explicit content type, reply-from sends the body as is instead of encoding it.
        const body =
          typeof request.body === 'string'
            ? {
                body: request.body,
                contentType: request.headers['content-type'] ?? 'application/octet-stream',
              }
            : {};
        return reply.from(`${deps.upstreams[upstream]}${path}${query ? `?${query}` : ''}`, {
          ...body,
          rewriteRequestHeaders: (_request, headers) =>
            upstreamHeaders(headers, { token, requestId: request.id }),
          rewriteHeaders: (headers) => downstreamHeaders(headers),
        });
      },
    );
  });
}
