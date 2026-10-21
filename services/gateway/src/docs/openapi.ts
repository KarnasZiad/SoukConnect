import { resolveUpstream, UPSTREAMS, type Upstream } from '../proxy/routing.js';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  [key: string]: unknown;
}

/**
 * One document for the public API: the gateway's own routes, plus every route of the services
 * that the gateway actually exposes, under `/api`. The public API authenticates with the session
 * cookie; the internal token of the services is an implementation detail and is left out.
 */
export function mergeDocuments(
  gateway: OpenApiDocument,
  services: Partial<Record<Upstream, OpenApiDocument>>,
  cookieName: string,
): OpenApiDocument {
  const paths: Record<string, unknown> = Object.fromEntries(
    Object.entries(gateway.paths).filter(([path]) => path.startsWith('/api/')),
  );
  const schemas: Record<string, unknown> = { ...gateway.components?.schemas };
  for (const upstream of UPSTREAMS) {
    const document = services[upstream];
    if (!document) continue;
    for (const [path, operations] of Object.entries(document.paths)) {
      // Only what the routing table sends to this service: health and internals stay hidden.
      const concrete = path.replace(/\{[^}]+\}/g, 'x');
      if (resolveUpstream(concrete) === upstream) paths[`/api${path}`] = operations;
    }
    Object.assign(schemas, document.components?.schemas);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'SoukConnect API',
      version: gateway.info.version,
      description:
        'Public API of the marketplace, served by the gateway on the same origin as the site.',
    },
    servers: [{ url: '/' }],
    paths: Object.fromEntries(
      Object.entries(paths).sort(([left], [right]) => left.localeCompare(right)),
    ),
    components: {
      schemas,
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: cookieName } },
    },
    security: [{ session: [] }],
  };
}

/** Keeps the merged document fresh; a service that cannot answer keeps its previous paths. */
export class OpenApiAggregator {
  private services: Partial<Record<Upstream, OpenApiDocument>> = {};
  private merged: OpenApiDocument | null = null;

  constructor(
    private readonly own: () => OpenApiDocument,
    private readonly fetchDocument: (upstream: Upstream) => Promise<OpenApiDocument>,
    private readonly cookieName: string,
  ) {}

  async refresh(): Promise<void> {
    const results = await Promise.allSettled(
      UPSTREAMS.map(async (upstream) => [upstream, await this.fetchDocument(upstream)] as const),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') this.services[result.value[0]] = result.value[1];
    }
    this.merged = mergeDocuments(this.own(), this.services, this.cookieName);
  }

  current(): OpenApiDocument {
    this.merged ??= mergeDocuments(this.own(), this.services, this.cookieName);
    return this.merged;
  }
}
