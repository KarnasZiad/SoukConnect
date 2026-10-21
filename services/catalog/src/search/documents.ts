import { LOCALES, type LocalizedText } from '@soukconnect/contracts';
import type { Product, Shop } from '../domain/model.js';

/** One product in the search index: a projection of MongoDB, rebuilt from it at any time. */
export interface SearchDocument {
  id: string;
  slug: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
  city: string;
  category: string;
  material: string;
  price: number;
  inStock: boolean;
  image: string | null;
  title_fr?: string;
  title_en?: string;
  title_ar?: string;
  description_fr?: string;
  description_en?: string;
  description_ar?: string;
  /** Epoch milliseconds: Meilisearch sorts on numbers. */
  publishedAt: number;
}

function perLocale(prefix: 'title' | 'description', text: LocalizedText) {
  return Object.fromEntries(
    LOCALES.flatMap((locale) => {
      const value = text[locale];
      return value === undefined ? [] : [[`${prefix}_${locale}`, value]];
    }),
  );
}

export function toSearchDocument(product: Product, shop: Shop): SearchDocument {
  return {
    id: product.id,
    slug: product.slug,
    shopId: shop.id,
    shopSlug: shop.slug,
    shopName: shop.name,
    city: shop.city,
    category: product.category,
    material: product.attributes.material,
    price: product.price,
    inStock: product.stock > 0,
    image: product.images[0]?.url ?? null,
    ...perLocale('title', product.title),
    // Descriptions are long: the first 1000 characters carry the useful words.
    ...perLocale(
      'description',
      Object.fromEntries(
        Object.entries(product.description).map(([locale, text]) => [locale, text.slice(0, 1000)]),
      ),
    ),
    publishedAt: (product.publishedAt ?? product.updatedAt).getTime(),
  };
}
