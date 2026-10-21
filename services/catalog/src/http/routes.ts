import { PRODUCT_STATUSES } from '@soukconnect/contracts';
import {
  conflict,
  type createService,
  notFound,
  ProblemError,
  requireShop,
  requireUser,
} from '@soukconnect/service-kit';
import { z } from 'zod';
import {
  type Product,
  productInputSchema,
  productPatchSchema,
  shopInputSchema,
} from '../domain/model.js';
import type { CatalogStore, SearchIndex } from '../ports.js';
import { searchQuerySchema } from '../search/query.js';
import {
  publicProductView,
  publicShopView,
  sellerProductView,
  sellerShopView,
  toPublicProduct,
  toPublicShop,
  toSellerProduct,
  toSellerShop,
} from './views.js';

type App = Awaited<ReturnType<typeof createService>>;

export interface RouteDeps {
  store: CatalogStore;
  search: SearchIndex;
  allowedImageHosts: readonly string[];
}

const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict();
const idParams = z.object({ id: z.uuid() }).strict();
const pageQuery = z
  .object({
    status: z.enum(PRODUCT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const REFUSALS = {
  'invalid-transition': 'This status change is not allowed',
  'needs-images': 'A product needs at least one image to be published',
  'shop-inactive': 'The shop must be active to publish products',
} as const;

export function registerRoutes(app: App, deps: RouteDeps): void {
  const { store } = deps;
  const productInput = productInputSchema(deps.allowedImageHosts);
  const productPatch = productPatchSchema(deps.allowedImageHosts);

  async function ownShop(shopId: string) {
    const shop = await store.getShop(shopId);
    if (!shop) throw notFound('Open your shop first');
    return shop;
  }

  // ---- Public reads: visitors and robots, through the gateway

  app.get(
    '/products',
    {
      schema: {
        tags: ['public'],
        querystring: z
          .object({
            ids: z
              .string()
              .transform((value) => [...new Set(value.split(','))])
              .pipe(z.array(z.uuid()).min(1).max(50)),
          })
          .strict(),
        response: { 200: z.object({ items: z.array(publicProductView) }) },
      },
    },
    async (request) => {
      // The products of a cart in one call; those no longer listed are simply absent.
      const found = await store.getListedProducts(request.query.ids);
      return { items: found.map(({ product, shop }) => toPublicProduct(product, shop)) };
    },
  );

  app.get(
    '/products/:slug',
    {
      schema: {
        tags: ['public'],
        params: slugParams,
        response: { 200: publicProductView },
      },
    },
    async (request) => {
      const found = await store.getListedProduct(request.params.slug);
      if (!found) throw notFound();
      return toPublicProduct(found.product, found.shop);
    },
  );

  app.get(
    '/shops/:slug',
    { schema: { tags: ['public'], params: slugParams, response: { 200: publicShopView } } },
    async (request) => {
      const shop = await store.getShopBySlug(request.params.slug);
      if (shop?.status !== 'ACTIVE') throw notFound();
      return toPublicShop(shop);
    },
  );

  app.get(
    '/search',
    { schema: { tags: ['public'], querystring: searchQuerySchema } },
    async (request) => deps.search.search(request.query),
  );

  // ---- Seller space (US-08, US-09)

  app.post(
    '/seller/shop',
    { schema: { tags: ['seller'], body: shopInputSchema, response: { 201: sellerShopView } } },
    async (request, reply) => {
      const shopId = requireShop(request);
      const shop = await store.createShop(shopId, request.body);
      if (shop === 'exists') throw conflict('This account already has a shop');
      return reply.code(201).send(toSellerShop(shop));
    },
  );

  app.get(
    '/seller/shop',
    { schema: { tags: ['seller'], response: { 200: sellerShopView } } },
    async (request) => toSellerShop(await ownShop(requireShop(request))),
  );

  app.patch(
    '/seller/shop',
    {
      schema: {
        tags: ['seller'],
        body: shopInputSchema.partial(),
        response: { 200: sellerShopView },
      },
    },
    async (request) => {
      const shop = await store.updateShop(requireShop(request), request.body);
      if (!shop) throw notFound('Open your shop first');
      return toSellerShop(shop);
    },
  );

  app.post(
    '/seller/products',
    { schema: { tags: ['seller'], body: productInput, response: { 201: sellerProductView } } },
    async (request, reply) => {
      const shop = await ownShop(requireShop(request));
      const product = await store.createProduct(shop, request.body);
      return reply.code(201).send(toSellerProduct(product));
    },
  );

  app.get(
    '/seller/products',
    {
      schema: {
        tags: ['seller'],
        querystring: pageQuery,
        response: {
          200: z.object({
            items: z.array(sellerProductView),
            total: z.int(),
            page: z.int(),
            perPage: z.int(),
          }),
        },
      },
    },
    async (request) => {
      const result = await store.listShopProducts(requireShop(request), request.query);
      return { ...result, items: result.items.map(toSellerProduct) };
    },
  );

  app.get(
    '/seller/products/:id',
    { schema: { tags: ['seller'], params: idParams, response: { 200: sellerProductView } } },
    async (request) => {
      // A product of another shop answers like a product that does not exist (T2, I1).
      const product = await store.getOwnProduct(requireShop(request), request.params.id);
      if (!product) throw notFound();
      return toSellerProduct(product);
    },
  );

  app.patch(
    '/seller/products/:id',
    {
      schema: {
        tags: ['seller'],
        params: idParams,
        body: productPatch,
        response: { 200: sellerProductView },
      },
    },
    async (request) => {
      const shopId = requireShop(request);
      const current = await store.getOwnProduct(shopId, request.params.id);
      if (!current) throw notFound();
      const merged = productInput.safeParse({ ...editable(current), ...request.body });
      if (!merged.success) {
        throw new ProblemError(400, 'Bad Request', 'The product is not valid after this change', {
          errors: merged.error.issues.map((issue) => ({
            path: `/${issue.path.join('/')}`,
            message: issue.message,
          })),
        });
      }
      const product = await store.replaceProduct(shopId, request.params.id, merged.data);
      if (!product) throw notFound();
      return toSellerProduct(product);
    },
  );

  app.post(
    '/seller/products/:id/status',
    {
      schema: {
        tags: ['seller'],
        params: idParams,
        body: z.object({ status: z.enum(PRODUCT_STATUSES) }).strict(),
        response: { 200: sellerProductView },
      },
    },
    async (request) => {
      const shop = await ownShop(requireShop(request));
      const result = await store.setProductStatus(shop, request.params.id, request.body.status);
      if (result === null) throw notFound();
      if (typeof result === 'string') throw conflict(REFUSALS[result], { reason: result });
      return toSellerProduct(result);
    },
  );

  // ---- Moderation (US-15): a shop becomes visible once activated

  app.post(
    '/moderation/shops/:id/status',
    {
      schema: {
        tags: ['moderation'],
        params: idParams,
        body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).strict(),
        response: { 200: sellerShopView },
      },
    },
    async (request) => {
      requireUser(request, 'moderator');
      const shop = await store.setShopStatus(request.params.id, request.body.status);
      if (!shop) throw notFound();
      return toSellerShop(shop);
    },
  );
}

/** The fields a seller may change, as they are now. */
function editable(product: Product) {
  return {
    title: product.title,
    description: product.description,
    price: product.price,
    stock: product.stock,
    images: product.images,
    category: product.category,
    attributes: product.attributes,
  };
}
