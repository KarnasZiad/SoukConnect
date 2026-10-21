export const UPSTREAMS = ['catalog', 'orders', 'payments', 'notifications'] as const;
export type Upstream = (typeof UPSTREAMS)[number];

/**
 * Public paths (after `/api`) and the service that answers them, first match wins. The services
 * keep the same paths, so the aggregated OpenAPI document is the union of theirs under `/api`.
 */
const RULES: { pattern: RegExp; upstream: Upstream }[] = [
  { pattern: /^\/orders\/[^/]+\/payment$/, upstream: 'payments' },
  { pattern: /^\/seller\/balance$/, upstream: 'payments' },
  { pattern: /^\/webhooks\/stripe$/, upstream: 'payments' },
  { pattern: /^\/orders(\/|$)/, upstream: 'orders' },
  { pattern: /^\/seller\/(orders|stats)(\/|$)/, upstream: 'orders' },
  { pattern: /^\/(products|shops|search)(\/|$)/, upstream: 'catalog' },
  { pattern: /^\/seller\/(shop|products)(\/|$)/, upstream: 'catalog' },
  { pattern: /^\/moderation\//, upstream: 'catalog' },
  { pattern: /^\/(conversations|notifications)(\/|$)/, upstream: 'notifications' },
];

/** Only plain segments: no traversal, no encoded separators, no empty segment. */
const SAFE_PATH = /^(\/[A-Za-z0-9._~-]+)+$/;

export function resolveUpstream(path: string): Upstream | null {
  if (
    !SAFE_PATH.test(path) ||
    path.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    return null;
  }
  return RULES.find((rule) => rule.pattern.test(path))?.upstream ?? null;
}

/** Request headers passed to a service; everything else, cookies and identities first, stays here. */
const FORWARDED = new Set([
  'accept',
  'accept-language',
  'content-type',
  'idempotency-key',
  'stripe-signature',
  'user-agent',
]);

export function upstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  internal: { token: string; requestId: string },
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (FORWARDED.has(name.toLowerCase()) && typeof value === 'string')
      headers[name.toLowerCase()] = value;
  }
  headers.authorization = `Bearer ${internal.token}`;
  headers['x-request-id'] = internal.requestId;
  return headers;
}

/** Response headers a service may not set on the public origin. */
export function downstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const { 'set-cookie': _cookie, server: _server, ...headers } = incoming;
  return headers;
}
