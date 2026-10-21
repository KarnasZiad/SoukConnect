import { describe, expect, it } from 'vitest';
import { rugInput } from '../../test/fakes.js';
import type { Product, Shop } from '../domain/model.js';
import { toSearchDocument } from './documents.js';
import { searchQuerySchema, toHit, toMeiliRequest } from './query.js';

const shop: Shop = {
  id: '0199f0a4-7a5b-7c1e-9f00-0000000000c1',
  slug: 'atelier-fatima',
  name: 'Atelier Fatima',
  city: 'marrakech',
  description: { fr: 'Tapis' },
  status: 'ACTIVE',
  commissionBps: 1000,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const product = {
  id: '0199f0a4-7a5b-7c1e-9f00-0000000000a1',
  shopId: shop.id,
  slug: 'tapis-beni-ouarain-0000a1',
  ...rugInput,
  title: { fr: 'Tapis Beni Ouarain', ar: 'زربية بني وراين' },
  description: { fr: 'x'.repeat(1500) },
  currency: 'MAD',
  sold: 0,
  status: 'PUBLISHED',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  publishedAt: new Date('2026-10-02T00:00:00Z'),
} as Product;

describe('toSearchDocument', () => {
  it('projects a product and its shop into one flat document', () => {
    const document = toSearchDocument(product, shop);

    expect(document).toMatchObject({
      id: product.id,
      shopName: 'Atelier Fatima',
      city: 'marrakech',
      category: 'rug',
      material: 'wool',
      price: 450_000,
      inStock: true,
      image: rugInput.images[0]?.url,
      title_fr: 'Tapis Beni Ouarain',
      title_ar: 'زربية بني وراين',
      publishedAt: Date.parse('2026-10-02T00:00:00Z'),
    });
    expect(document).not.toHaveProperty('title_en');
    expect(document.description_fr).toHaveLength(1000);
    expect(toSearchDocument({ ...product, stock: 0, images: [] }, shop)).toMatchObject({
      inStock: false,
      image: null,
    });
  });
});

describe('search queries', () => {
  it('applies defaults', () => {
    expect(searchQuerySchema.parse({})).toEqual({
      q: '',
      sort: 'relevance',
      page: 1,
      perPage: 24,
      locale: 'fr',
    });
  });

  it('builds filters from enumerations and numbers only', () => {
    const query = searchQuerySchema.parse({
      q: 'tapis',
      category: 'rug',
      city: 'fes',
      material: 'wool',
      shop: shop.id,
      priceMin: '10000',
      priceMax: '500000',
      inStock: 'true',
      sort: 'newest',
      page: '2',
      perPage: '12',
    });

    expect(toMeiliRequest(query)).toEqual({
      q: 'tapis',
      params: {
        filter: [
          'category = "rug"',
          'city = "fes"',
          'material = "wool"',
          `shopId = "${shop.id}"`,
          'price >= 10000',
          'price <= 500000',
          'inStock = true',
        ],
        facets: ['category', 'city', 'material'],
        page: 2,
        hitsPerPage: 12,
        sort: ['publishedAt:desc'],
      },
    });
    expect(toMeiliRequest(searchQuerySchema.parse({ sort: 'price-desc' })).params.sort).toEqual([
      'price:desc',
    ]);
    expect(toMeiliRequest(searchQuerySchema.parse({})).params).not.toHaveProperty('sort');
  });

  it('shows the title in the requested language, or says it is not translated', () => {
    const document = toSearchDocument(product, shop);

    expect(toHit(document, 'ar')).toMatchObject({ title: 'زربية بني وراين', translated: true });
    expect(toHit(document, 'en')).toMatchObject({ title: 'Tapis Beni Ouarain', translated: false });
    expect(toHit(document, 'fr').shop).toEqual({
      slug: 'atelier-fatima',
      name: 'Atelier Fatima',
      city: 'marrakech',
    });
  });
});
