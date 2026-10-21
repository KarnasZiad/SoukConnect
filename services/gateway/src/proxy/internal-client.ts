import { type Actor, signInternalToken, type SigningKey } from '@soukconnect/service-kit';
import type { Upstream } from './routing.js';

export interface UpstreamResponse<T = unknown> {
  status: number;
  body: T;
}

/** Calls made by the gateway itself (cart enrichment, checkout), signed like proxied requests. */
export interface InternalClient {
  call<T>(
    upstream: Upstream,
    actor: Actor,
    request: {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
      requestId: string;
    },
  ): Promise<UpstreamResponse<T>>;
}

export class FetchInternalClient implements InternalClient {
  constructor(
    private readonly key: SigningKey,
    private readonly urls: Record<Upstream, string>,
    private readonly timeoutMs = 5_000,
  ) {}

  async call<T>(
    upstream: Upstream,
    actor: Actor,
    request: {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
      requestId: string;
    },
  ): Promise<UpstreamResponse<T>> {
    const response = await fetch(`${this.urls[upstream]}${request.path}`, {
      method: request.method,
      headers: {
        ...request.headers,
        accept: 'application/json',
        authorization: `Bearer ${await signInternalToken(this.key, upstream, actor)}`,
        'x-request-id': request.requestId,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
}
