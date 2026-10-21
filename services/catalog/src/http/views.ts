import {
  CATEGORIES,
  CITIES,
  LOCALES,
  PRODUCT_STATUSES,
  SHOP_STATUSES,
} from '@soukconnect/contracts';
import { z } from 'zod';
import type { Product, Shop } from '../domain/model.js';

const text = z.object(Object.fromEntries(LOCALES.map((locale) => [locale, z.string().optional()])));

/** What visitors see of a shop: no commission rate, no status. */
export const publicShopView = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  city: z.enum(CITIES),
  description: text,
});

export const sellerShopView = publicShopView.extend({
  status: z.enum(SHOP_STATUSES),
  commissionBps: z.int(),
  createdAt: z.iso.datetime(),
});

const image = z.object({ url: z.string(), alt: text.optional() });

export const publicProductView = z.object({
  id: z.uuid(),
  slug: z.string(),
  category: z.enum(CATEGORIES),
  attributes: z.record(z.string(), z.unknown()),
  title: text,
  description: text,
  price: z.int(),
  currency: z.literal('MAD'),
  stock: z.int(),
  images: z.array(image),
  publishedAt: z.iso.datetime().nullable(),
  shop: publicShopView,
});

export const sellerProductView = publicProductView.omit({ shop: true }).extend({
  shopId: z.uuid(),
  status: z.enum(PRODUCT_STATUSES),
  sold: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export function toPublicShop(shop: Shop): z.infer<typeof publicShopView> {
  return {
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
    city: shop.city,
    description: shop.description,
  };
}

export function toSellerShop(shop: Shop): z.infer<typeof sellerShopView> {
  return {
    ...toPublicShop(shop),
    status: shop.status,
    commissionBps: shop.commissionBps,
    createdAt: shop.createdAt.toISOString(),
  };
}

export function toPublicProduct(product: Product, shop: Shop): z.infer<typeof publicProductView> {
  return {
    id: product.id,
    slug: product.slug,
    category: product.category,
    attributes: product.attributes,
    title: product.title,
    description: product.description,
    price: product.price,
    currency: product.currency,
    stock: product.stock,
    images: product.images,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    shop: toPublicShop(shop),
  };
}

export function toSellerProduct(product: Product): z.infer<typeof sellerProductView> {
  return {
    id: product.id,
    slug: product.slug,
    shopId: product.shopId,
    category: product.category,
    attributes: product.attributes,
    title: product.title,
    description: product.description,
    price: product.price,
    currency: product.currency,
    stock: product.stock,
    images: product.images,
    status: product.status,
    sold: product.sold,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
