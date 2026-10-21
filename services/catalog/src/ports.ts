import type { Envelope, ProductStatus, ShopStatus } from '@soukconnect/contracts';
import type { Product, ProductInput, Shop, ShopInput } from './domain/model.js';
import type { StatusRefusal } from './domain/rules.js';
import type { SearchQuery, SearchResult } from './search/query.js';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

/** Shops and products in MongoDB; every write records `catalog.product-changed` in the outbox. */
export interface CatalogStore {
  createShop(ownerId: string, input: ShopInput): Promise<Shop | 'exists'>;
  updateShop(shopId: string, input: Partial<ShopInput>): Promise<Shop | null>;
  setShopStatus(shopId: string, status: ShopStatus): Promise<Shop | null>;
  getShop(shopId: string): Promise<Shop | null>;
  getShopBySlug(slug: string): Promise<Shop | null>;

  createProduct(shop: Shop, input: ProductInput): Promise<Product>;
  /** `input` is the complete product after the patch, already validated. */
  replaceProduct(shopId: string, productId: string, input: ProductInput): Promise<Product | null>;
  setProductStatus(
    shop: Shop,
    productId: string,
    status: ProductStatus,
  ): Promise<Product | StatusRefusal | null>;
  getOwnProduct(shopId: string, productId: string): Promise<Product | null>;
  listShopProducts(
    shopId: string,
    options: { status?: ProductStatus; page: number; perPage: number },
  ): Promise<Page<Product>>;
  /** A product visitors may see: published, in an active shop. */
  getListedProduct(slug: string): Promise<{ product: Product; shop: Shop } | null>;
  /** The listed products among these identifiers, for the cart; unknown or unlisted ones are left out. */
  getListedProducts(ids: readonly string[]): Promise<{ product: Product; shop: Shop }[]>;
  getForIndex(productId: string): Promise<{ product: Product; shop: Shop } | null>;
}

/** Stock reservations of the order saga, each one handled once (inbox) and answered (outbox). */
export interface StockLedger {
  reserve(command: Envelope<'catalog.reserve-stock'>): Promise<void>;
  release(command: Envelope<'catalog.release-stock'>): Promise<void>;
  commit(command: Envelope<'catalog.commit-stock'>): Promise<void>;
}

export interface SearchIndex {
  search(query: SearchQuery): Promise<SearchResult>;
}
