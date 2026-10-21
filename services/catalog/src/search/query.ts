import {
  CATEGORIES,
  CITIES,
  type Locale,
  LOCALES,
  MATERIALS,
  pickText,
} from '@soukconnect/contracts';
import { z } from 'zod';
import type { SearchDocument } from './documents.js';

export const SORTS = ['relevance', 'price-asc', 'price-desc', 'newest'] as const;
export const FACETS = ['category', 'city', 'material'] as const;

/**
 * Parameters of `GET /search`. Every filter value is an enumeration, an integer or a UUID: a
 * filter expression is never built from free text.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(100).default(''),
    category: z.enum(CATEGORIES).optional(),
    city: z.enum(CITIES).optional(),
    material: z.enum(MATERIALS as [string, ...string[]]).optional(),
    priceMin: z.coerce.number().int().min(0).optional(),
    priceMax: z.coerce.number().int().min(0).optional(),
    shop: z.uuid().optional(),
    inStock: z.enum(['true', 'false']).optional(),
    sort: z.enum(SORTS).default('relevance'),
    page: z.coerce.number().int().min(1).max(100).default(1),
    perPage: z.coerce.number().int().min(1).max(48).default(24),
    locale: z.enum(LOCALES).default('fr'),
  })
  .strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface SearchHit {
  id: string;
  slug: string;
  title: string;
  /** False when the title is shown in another language than the one asked for (US-01). */
  translated: boolean;
  price: number;
  image: string | null;
  inStock: boolean;
  shop: { slug: string; name: string; city: string };
}

export interface SearchResult {
  hits: SearchHit[];
  facets: Record<(typeof FACETS)[number], Record<string, number>>;
  total: number;
  page: number;
  totalPages: number;
  processingTimeMs: number;
}

/** Meilisearch request for a query: filter expressions, facets, sort and pagination. */
export function toMeiliRequest(query: SearchQuery) {
  const filter: string[] = [];
  if (query.category) filter.push(`category = "${query.category}"`);
  if (query.city) filter.push(`city = "${query.city}"`);
  if (query.material) filter.push(`material = "${query.material}"`);
  if (query.shop) filter.push(`shopId = "${query.shop}"`);
  if (query.priceMin !== undefined) filter.push(`price >= ${query.priceMin}`);
  if (query.priceMax !== undefined) filter.push(`price <= ${query.priceMax}`);
  if (query.inStock) filter.push(`inStock = ${query.inStock}`);
  const sort = {
    relevance: undefined,
    'price-asc': ['price:asc'],
    'price-desc': ['price:desc'],
    newest: ['publishedAt:desc'],
  }[query.sort];
  return {
    q: query.q,
    params: {
      filter,
      facets: [...FACETS],
      page: query.page,
      hitsPerPage: query.perPage,
      ...(sort ? { sort } : {}),
    },
  };
}

function titleOf(document: SearchDocument, locale: Locale) {
  return pickText({ fr: document.title_fr, en: document.title_en, ar: document.title_ar }, locale);
}

export function toHit(document: SearchDocument, locale: Locale): SearchHit {
  const title = titleOf(document, locale);
  return {
    id: document.id,
    slug: document.slug,
    title: title.value,
    translated: title.translated,
    price: document.price,
    image: document.image,
    inStock: document.inStock,
    shop: { slug: document.shopSlug, name: document.shopName, city: document.city },
  };
}
