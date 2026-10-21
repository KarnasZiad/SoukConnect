import type { Db } from 'mongodb';
import type { Product, Shop } from '../domain/model.js';

export type ProductDocument = Omit<Product, 'id'> & { _id: string };
export type ShopDocument = Omit<Shop, 'id'> & { _id: string };

export interface ReservationDocument {
  /** The order: one reservation per order. */
  _id: string;
  status: 'RESERVED' | 'COMMITTED' | 'RELEASED';
  items: { productId: string; quantity: number }[];
  createdAt: Date;
  updatedAt: Date;
}

export function collections(db: Db) {
  return {
    products: db.collection<ProductDocument>('products'),
    shops: db.collection<ShopDocument>('shops'),
    reservations: db.collection<ReservationDocument>('reservations'),
  };
}

export function toProduct({ _id, ...rest }: ProductDocument): Product {
  return { id: _id, ...rest } as Product;
}

export function toShop({ _id, ...rest }: ShopDocument): Shop {
  return { id: _id, ...rest };
}

/** Indexes of the catalog: unique slugs, the shelf of a shop, published products by date. */
export async function ensureCatalogIndexes(db: Db): Promise<void> {
  const { products, shops } = collections(db);
  await products.createIndex({ slug: 1 }, { unique: true, name: 'slug' });
  await products.createIndex({ shopId: 1, updatedAt: -1 }, { name: 'shop_shelf' });
  await products.createIndex({ status: 1, _id: 1 }, { name: 'status' });
  await shops.createIndex({ slug: 1 }, { unique: true, name: 'slug' });
}
