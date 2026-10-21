import {
  createEnvelope,
  DEFAULT_COMMISSION_BPS,
  type ProductStatus,
  type ShopStatus,
  uuidv7,
} from '@soukconnect/contracts';
import { enqueue } from '@soukconnect/messaging/mongo';
import { type ClientSession, type Db, type MongoClient, MongoServerError } from 'mongodb';
import type { Product, ProductInput, Shop, ShopInput } from '../domain/model.js';
import { statusRefusal, type StatusRefusal } from '../domain/rules.js';
import { slugify, withSuffix } from '../domain/slug.js';
import type { CatalogStore, Page } from '../ports.js';
import {
  collections,
  type ProductDocument,
  type ShopDocument,
  toProduct,
  toShop,
} from './documents.js';

const DUPLICATE_KEY = 11000;

function isDuplicate(error: unknown, index?: string): boolean {
  return (
    error instanceof MongoServerError &&
    error.code === DUPLICATE_KEY &&
    (index === undefined || error.message.includes(`index: ${index}`))
  );
}

/** Product and shop writes, each with its `catalog.product-changed` message in the same transaction. */
export class MongoCatalogStore implements CatalogStore {
  private readonly products;
  private readonly shops;

  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    /** Wakes the outbox relay after a commit. */
    private readonly onCommit: () => void = () => undefined,
  ) {
    ({ products: this.products, shops: this.shops } = collections(db));
  }

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(() => work(session));
      this.onCommit();
      return result;
    } finally {
      await session.endSession();
    }
  }

  private async changed(product: Product | ProductDocument, session: ClientSession): Promise<void> {
    const id = 'id' in product ? product.id : product._id;
    await enqueue(
      this.db,
      createEnvelope(
        'catalog.product-changed',
        { productId: id, shopId: product.shopId, slug: product.slug, status: product.status },
        { correlationId: id },
      ),
      session,
    );
  }

  async createShop(ownerId: string, input: ShopInput): Promise<Shop | 'exists'> {
    const now = new Date();
    const base = slugify(input.name, 'atelier');
    for (const slug of [base, withSuffix(base, uuidv7())]) {
      const document: ShopDocument = {
        _id: ownerId,
        slug,
        ...input,
        status: 'PENDING',
        commissionBps: DEFAULT_COMMISSION_BPS,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.shops.insertOne(document);
        return toShop(document);
      } catch (error) {
        if (isDuplicate(error, 'slug')) continue;
        if (isDuplicate(error)) return 'exists';
        throw error;
      }
    }
    throw new Error('Could not find a free slug for the shop');
  }

  async updateShop(shopId: string, input: Partial<ShopInput>): Promise<Shop | null> {
    const document = await this.shops.findOneAndUpdate(
      { _id: shopId },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return document ? toShop(document) : null;
  }

  /** Activating or suspending a shop shows or hides all its published products in the search. */
  async setShopStatus(shopId: string, status: ShopStatus): Promise<Shop | null> {
    return this.transaction(async (session) => {
      const document = await this.shops.findOneAndUpdate(
        { _id: shopId },
        { $set: { status, updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!document) return null;
      const published = this.products.find({ shopId, status: 'PUBLISHED' }, { session });
      for await (const product of published) await this.changed(product, session);
      return toShop(document);
    });
  }

  async getShop(shopId: string): Promise<Shop | null> {
    const document = await this.shops.findOne({ _id: shopId });
    return document ? toShop(document) : null;
  }

  async getShopBySlug(slug: string): Promise<Shop | null> {
    const document = await this.shops.findOne({ slug });
    return document ? toShop(document) : null;
  }

  async createProduct(shop: Shop, input: ProductInput): Promise<Product> {
    const id = uuidv7();
    const now = new Date();
    const title = input.title.fr ?? input.title.en ?? input.title.ar ?? '';
    const document = {
      _id: id,
      shopId: shop.id,
      slug: withSuffix(slugify(title), id),
      ...input,
      currency: 'MAD',
      sold: 0,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    } as ProductDocument;
    return this.transaction(async (session) => {
      await this.products.insertOne(document, { session });
      await this.changed(document, session);
      return toProduct(document);
    });
  }

  async replaceProduct(
    shopId: string,
    productId: string,
    input: ProductInput,
  ): Promise<Product | null> {
    return this.transaction(async (session) => {
      const document = await this.products.findOneAndUpdate(
        { _id: productId, shopId },
        { $set: { ...input, updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!document) return null;
      await this.changed(document, session);
      return toProduct(document);
    });
  }

  async setProductStatus(
    shop: Shop,
    productId: string,
    status: ProductStatus,
  ): Promise<Product | StatusRefusal | null> {
    return this.transaction(async (session) => {
      const current = await this.products.findOne({ _id: productId, shopId: shop.id }, { session });
      if (!current) return null;
      const refusal = statusRefusal(toProduct(current), shop, status);
      if (refusal) return refusal;
      const now = new Date();
      const document = await this.products.findOneAndUpdate(
        // Conditional on the status read: a concurrent change makes this one a no-op.
        { _id: productId, shopId: shop.id, status: current.status },
        {
          $set: {
            status,
            updatedAt: now,
            ...(status === 'PUBLISHED' && current.publishedAt === null ? { publishedAt: now } : {}),
          },
        },
        { returnDocument: 'after', session },
      );
      if (!document) return 'invalid-transition';
      await this.changed(document, session);
      return toProduct(document);
    });
  }

  async getOwnProduct(shopId: string, productId: string): Promise<Product | null> {
    const document = await this.products.findOne({ _id: productId, shopId });
    return document ? toProduct(document) : null;
  }

  async listShopProducts(
    shopId: string,
    options: { status?: ProductStatus; page: number; perPage: number },
  ): Promise<Page<Product>> {
    const filter = { shopId, ...(options.status ? { status: options.status } : {}) };
    const [documents, total] = await Promise.all([
      this.products
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((options.page - 1) * options.perPage)
        .limit(options.perPage)
        .toArray(),
      this.products.countDocuments(filter),
    ]);
    return { items: documents.map(toProduct), total, page: options.page, perPage: options.perPage };
  }

  async getListedProduct(slug: string): Promise<{ product: Product; shop: Shop } | null> {
    const product = await this.products.findOne({ slug, status: 'PUBLISHED' });
    if (!product) return null;
    const shop = await this.shops.findOne({ _id: product.shopId, status: 'ACTIVE' });
    return shop ? { product: toProduct(product), shop: toShop(shop) } : null;
  }

  async getForIndex(productId: string): Promise<{ product: Product; shop: Shop } | null> {
    const product = await this.products.findOne({ _id: productId });
    if (!product) return null;
    const shop = await this.shops.findOne({ _id: product.shopId });
    return shop ? { product: toProduct(product), shop: toShop(shop) } : null;
  }

  /** Every listed product with its shop, in batches: the source of a full reindex. */
  async *listedInBatches(size = 500): AsyncGenerator<{ product: Product; shop: Shop }[]> {
    const shops = new Map<string, Shop>();
    for await (const shop of this.shops.find({ status: 'ACTIVE' }))
      shops.set(shop._id, toShop(shop));
    let batch: { product: Product; shop: Shop }[] = [];
    for await (const document of this.products.find({ status: 'PUBLISHED' }).sort({ _id: 1 })) {
      const shop = shops.get(document.shopId);
      if (!shop) continue;
      batch.push({ product: toProduct(document), shop });
      if (batch.length === size) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }
}
