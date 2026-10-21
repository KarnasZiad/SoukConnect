import {
  DEFAULT_COMMISSION_BPS,
  type ProductStatus,
  type ShopStatus,
  uuidv7,
} from '@soukconnect/contracts';
import {
  createInternalVerifier,
  createLogger,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
  signInternalToken,
  type Actor,
} from '@soukconnect/service-kit';
import { buildApp } from '../src/app.js';
import type { Product, ProductInput, Shop, ShopInput } from '../src/domain/model.js';
import { statusRefusal, type StatusRefusal } from '../src/domain/rules.js';
import { slugify, withSuffix } from '../src/domain/slug.js';
import type { CatalogStore, Page, SearchIndex } from '../src/ports.js';
import type { SearchQuery, SearchResult } from '../src/search/query.js';

/** The catalog in memory, with the same rules as the MongoDB store. */
export class MemoryCatalogStore implements CatalogStore {
  shops = new Map<string, Shop>();
  products = new Map<string, Product>();
  changed: string[] = [];

  createShop(ownerId: string, input: ShopInput): Promise<Shop | 'exists'> {
    if (this.shops.has(ownerId)) return Promise.resolve('exists');
    const now = new Date();
    const shop: Shop = {
      id: ownerId,
      slug: slugify(input.name, 'atelier'),
      ...input,
      status: 'PENDING',
      commissionBps: DEFAULT_COMMISSION_BPS,
      createdAt: now,
      updatedAt: now,
    };
    this.shops.set(ownerId, shop);
    return Promise.resolve(shop);
  }

  updateShop(shopId: string, input: Partial<ShopInput>): Promise<Shop | null> {
    const shop = this.shops.get(shopId);
    if (!shop) return Promise.resolve(null);
    Object.assign(shop, input, { updatedAt: new Date() });
    return Promise.resolve(shop);
  }

  setShopStatus(shopId: string, status: ShopStatus): Promise<Shop | null> {
    const shop = this.shops.get(shopId);
    if (!shop) return Promise.resolve(null);
    shop.status = status;
    return Promise.resolve(shop);
  }

  getShop(shopId: string): Promise<Shop | null> {
    return Promise.resolve(this.shops.get(shopId) ?? null);
  }

  getShopBySlug(slug: string): Promise<Shop | null> {
    return Promise.resolve([...this.shops.values()].find((shop) => shop.slug === slug) ?? null);
  }

  createProduct(shop: Shop, input: ProductInput): Promise<Product> {
    const id = uuidv7();
    const now = new Date();
    const product = {
      id,
      shopId: shop.id,
      slug: withSuffix(slugify(input.title.fr ?? input.title.en ?? ''), id),
      ...input,
      currency: 'MAD',
      sold: 0,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    } as Product;
    this.products.set(id, product);
    this.changed.push(id);
    return Promise.resolve(product);
  }

  replaceProduct(shopId: string, productId: string, input: ProductInput): Promise<Product | null> {
    const product = this.products.get(productId);
    if (product?.shopId !== shopId) return Promise.resolve(null);
    const next = { ...product, ...input, updatedAt: new Date() } as Product;
    this.products.set(productId, next);
    this.changed.push(productId);
    return Promise.resolve(next);
  }

  setProductStatus(
    shop: Shop,
    productId: string,
    status: ProductStatus,
  ): Promise<Product | StatusRefusal | null> {
    const product = this.products.get(productId);
    if (product?.shopId !== shop.id) return Promise.resolve(null);
    const refusal = statusRefusal(product, shop, status);
    if (refusal) return Promise.resolve(refusal);
    product.status = status;
    if (status === 'PUBLISHED') product.publishedAt ??= new Date();
    this.changed.push(productId);
    return Promise.resolve(product);
  }

  getOwnProduct(shopId: string, productId: string): Promise<Product | null> {
    const product = this.products.get(productId);
    return Promise.resolve(product?.shopId === shopId ? product : null);
  }

  listShopProducts(
    shopId: string,
    options: { status?: ProductStatus; page: number; perPage: number },
  ): Promise<Page<Product>> {
    const items = [...this.products.values()].filter(
      (product) =>
        product.shopId === shopId && (!options.status || product.status === options.status),
    );
    const start = (options.page - 1) * options.perPage;
    return Promise.resolve({
      items: items.slice(start, start + options.perPage),
      total: items.length,
      page: options.page,
      perPage: options.perPage,
    });
  }

  getListedProduct(slug: string): Promise<{ product: Product; shop: Shop } | null> {
    const product = [...this.products.values()].find((item) => item.slug === slug);
    const shop = product ? this.shops.get(product.shopId) : undefined;
    return Promise.resolve(
      product && shop && product.status === 'PUBLISHED' && shop.status === 'ACTIVE'
        ? { product, shop }
        : null,
    );
  }

  getForIndex(productId: string): Promise<{ product: Product; shop: Shop } | null> {
    const product = this.products.get(productId);
    const shop = product ? this.shops.get(product.shopId) : undefined;
    return Promise.resolve(product && shop ? { product, shop } : null);
  }
}

export class FakeSearch implements SearchIndex {
  queries: SearchQuery[] = [];
  search(query: SearchQuery): Promise<SearchResult> {
    this.queries.push(query);
    return Promise.resolve({
      hits: [],
      facets: { category: { rug: 3 }, city: {}, material: {} },
      total: 3,
      page: query.page,
      totalPages: 1,
      processingTimeMs: 1,
    });
  }
}

export const sellerId = '0199f0a4-7a5b-7c1e-9f00-0000000000c1';
export const otherSellerId = '0199f0a4-7a5b-7c1e-9f00-0000000000c9';
export const buyerId = '0199f0a4-7a5b-7c1e-9f00-0000000000b1';
export const moderatorId = '0199f0a4-7a5b-7c1e-9f00-0000000000d1';

export const seller: Actor = { userId: sellerId, role: 'seller', shopId: sellerId };
export const otherSeller: Actor = { userId: otherSellerId, role: 'seller', shopId: otherSellerId };
export const buyer: Actor = { userId: buyerId, role: 'buyer', shopId: null };
export const moderator: Actor = { userId: moderatorId, role: 'moderator', shopId: null };
export const visitor: Actor = { userId: null, role: 'visitor', shopId: null };

export const IMAGE_HOST = 'images.soukconnect.ma';

export const rugInput = {
  title: { fr: 'Tapis Beni Ouarain', en: 'Beni Ouarain rug' },
  description: { fr: 'Laine naturelle, tissé à la main dans le Moyen Atlas.' },
  price: 450_000,
  stock: 2,
  images: [{ url: `https://${IMAGE_HOST}/rugs/beni-ouarain.jpg` }],
  category: 'rug' as const,
  attributes: {
    widthCm: 200,
    lengthCm: 300,
    material: 'wool' as const,
    style: 'beni-ouarain' as const,
  },
};

export const shopInput = {
  name: 'Atelier Fatima',
  city: 'marrakech' as const,
  description: { fr: 'Tapis berbères tissés à la main depuis trois générations.' },
};

/** The catalog API on in-memory adapters, with real internal tokens. */
export async function testApp() {
  const { privateJwk, publicJwk } = await generateSigningKeys('test');
  const key = await importSigningKey(JSON.stringify(privateJwk));
  const store = new MemoryCatalogStore();
  const search = new FakeSearch();
  const app = await buildApp({
    logger: createLogger('catalog-test', 'silent'),
    store,
    search,
    allowedImageHosts: [IMAGE_HOST],
    verifyToken: createInternalVerifier({
      audience: 'catalog',
      publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
    }),
  });
  async function call(
    actor: Actor,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await signInternalToken(key, 'catalog', actor)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  return { app, store, search, call };
}
