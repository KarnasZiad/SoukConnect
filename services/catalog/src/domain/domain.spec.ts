import { describe, expect, it } from 'vitest';
import { rugInput } from '../../test/fakes.js';
import type { Product, Shop } from './model.js';
import { isListed, quantitiesOf, statusRefusal, unavailableOf } from './rules.js';
import { slugify, withSuffix } from './slug.js';

const shop: Shop = {
  id: 'shop-1',
  slug: 'atelier',
  name: 'Atelier',
  city: 'safi',
  description: { fr: 'Poterie' },
  status: 'ACTIVE',
  commissionBps: 1000,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-1',
    shopId: shop.id,
    slug: 'tapis-1',
    ...rugInput,
    currency: 'MAD',
    sold: 0,
    status: 'DRAFT',
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    ...overrides,
  } as Product;
}

describe('slugify', () => {
  it('turns titles into readable URL segments', () => {
    expect(slugify('Tapis Béni Ouarain — 200×300')).toBe('tapis-beni-ouarain-200-300');
    expect(slugify('  Poterie de Safi !  ')).toBe('poterie-de-safi');
    expect(slugify('زربية بني وراين')).toBe('piece');
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('adds a short random suffix from the identifier', () => {
    expect(withSuffix('tapis', '0199f0a4-7a5b-7c1e-9f00-00000000abcd')).toBe('tapis-00abcd');
  });
});

describe('status rules', () => {
  it('publishes a product with images in an active shop', () => {
    expect(statusRefusal(product(), shop, 'PUBLISHED')).toBeNull();
    expect(statusRefusal(product({ images: [] }), shop, 'PUBLISHED')).toBe('needs-images');
    expect(statusRefusal(product(), { ...shop, status: 'PENDING' }, 'PUBLISHED')).toBe(
      'shop-inactive',
    );
  });

  it('allows only the defined transitions', () => {
    expect(statusRefusal(product({ status: 'ARCHIVED' }), shop, 'PUBLISHED')).toBe(
      'invalid-transition',
    );
    expect(statusRefusal(product({ status: 'ARCHIVED' }), shop, 'DRAFT')).toBeNull();
    expect(statusRefusal(product({ status: 'PUBLISHED' }), shop, 'PUBLISHED')).toBe(
      'invalid-transition',
    );
  });

  it('lists a product only when it is published in an active shop', () => {
    expect(isListed({ status: 'PUBLISHED' }, { status: 'ACTIVE' })).toBe(true);
    expect(isListed({ status: 'PUBLISHED' }, { status: 'SUSPENDED' })).toBe(false);
    expect(isListed({ status: 'DRAFT' }, { status: 'ACTIVE' })).toBe(false);
  });
});

describe('reservation rules', () => {
  it('sums the quantities of a product appearing on several lines', () => {
    expect(
      quantitiesOf([
        { productId: 'a', quantity: 1 },
        { productId: 'b', quantity: 2 },
        { productId: 'a', quantity: 3 },
      ]),
    ).toEqual(
      new Map([
        ['a', 4],
        ['b', 2],
      ]),
    );
  });

  it('reports every product that cannot be reserved, all or nothing', () => {
    const products = new Map([
      ['in-stock', product({ id: 'in-stock', status: 'PUBLISHED', stock: 5 })],
      ['short', product({ id: 'short', status: 'PUBLISHED', stock: 1 })],
      ['draft', product({ id: 'draft', status: 'DRAFT', stock: 9 })],
    ]);
    const shops = new Map([[shop.id, shop]]);

    expect(
      unavailableOf(
        new Map([
          ['in-stock', 5],
          ['short', 2],
          ['draft', 1],
          ['unknown', 1],
        ]),
        products,
        shops,
      ),
    ).toEqual([
      { productId: 'short', requested: 2, available: 1 },
      { productId: 'draft', requested: 1, available: 0 },
      { productId: 'unknown', requested: 1, available: 0 },
    ]);
    expect(unavailableOf(new Map([['in-stock', 5]]), products, shops)).toEqual([]);
  });
});
