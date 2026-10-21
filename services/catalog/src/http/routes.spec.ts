import { afterEach, describe, expect, it } from 'vitest';
import {
  buyer,
  IMAGE_HOST,
  moderator,
  otherSeller,
  rugInput,
  seller,
  sellerId,
  shopInput,
  testApp,
  visitor,
} from '../../test/fakes.js';

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
});

async function setup() {
  const context = await testApp();
  close = () => context.app.close();
  return context;
}

/** A seller with an active shop and one draft rug. */
async function withProduct() {
  const context = await setup();
  await context.call(seller, 'POST', '/seller/shop', shopInput);
  await context.call(moderator, 'POST', `/moderation/shops/${sellerId}/status`, {
    status: 'ACTIVE',
  });
  const created = await context.call(seller, 'POST', '/seller/products', rugInput);
  return { ...context, product: created.json<{ id: string; slug: string }>() };
}

describe('shops (US-08)', () => {
  it('opens one shop per seller, pending until a moderator activates it', async () => {
    const { call } = await setup();

    const created = await call(seller, 'POST', '/seller/shop', shopInput);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: sellerId,
      slug: 'atelier-fatima',
      status: 'PENDING',
      commissionBps: 1000,
    });
    expect((await call(seller, 'POST', '/seller/shop', shopInput)).statusCode).toBe(409);
    expect((await call(visitor, 'GET', '/shops/atelier-fatima')).statusCode).toBe(404);

    const activated = await call(moderator, 'POST', `/moderation/shops/${sellerId}/status`, {
      status: 'ACTIVE',
    });
    expect(activated.json()).toMatchObject({ status: 'ACTIVE' });
    const visible = await call(visitor, 'GET', '/shops/atelier-fatima');
    expect(visible.statusCode).toBe(200);
    // Visitors never see the commission rate.
    expect(visible.json()).not.toHaveProperty('commissionBps');
  });

  it('reserves shop management to sellers and moderation to moderators', async () => {
    const { call } = await setup();

    expect((await call(buyer, 'POST', '/seller/shop', shopInput)).statusCode).toBe(403);
    expect((await call(visitor, 'POST', '/seller/shop', shopInput)).statusCode).toBe(401);
    expect(
      (await call(seller, 'POST', `/moderation/shops/${sellerId}/status`, { status: 'ACTIVE' }))
        .statusCode,
    ).toBe(403);
    expect((await call(seller, 'GET', '/seller/shop')).statusCode).toBe(404);
  });

  it('validates the shop: known city, bounded texts', async () => {
    const { call } = await setup();

    expect(
      (await call(seller, 'POST', '/seller/shop', { ...shopInput, city: 'paris' })).statusCode,
    ).toBe(400);
    expect(
      (await call(seller, 'POST', '/seller/shop', { ...shopInput, name: 'x'.repeat(81) }))
        .statusCode,
    ).toBe(400);
  });

  it('lets the seller update the shop', async () => {
    const { call } = await setup();
    await call(seller, 'POST', '/seller/shop', shopInput);

    const updated = await call(seller, 'PATCH', '/seller/shop', { city: 'essaouira' });
    expect(updated.json()).toMatchObject({ city: 'essaouira' });
    expect((await call(otherSeller, 'PATCH', '/seller/shop', { city: 'fes' })).statusCode).toBe(
      404,
    );
  });
});

describe('products (US-09)', () => {
  it('creates a draft, then publishes it for visitors', async () => {
    const { call, product } = await withProduct();

    expect(product.slug).toMatch(/^tapis-beni-ouarain-[0-9a-f]{6}$/);
    expect((await call(visitor, 'GET', `/products/${product.slug}`)).statusCode).toBe(404);

    const published = await call(seller, 'POST', `/seller/products/${product.id}/status`, {
      status: 'PUBLISHED',
    });
    expect(published.json()).toMatchObject({ status: 'PUBLISHED' });

    const page = await call(visitor, 'GET', `/products/${product.slug}`);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      price: 450_000,
      currency: 'MAD',
      attributes: { widthCm: 200, material: 'wool' },
      shop: { slug: 'atelier-fatima', city: 'marrakech' },
    });
    expect(page.json()).not.toHaveProperty('sold');
  });

  it('refuses images outside the CDN, prices in decimals and attributes of another category', async () => {
    const { call } = await withProduct();
    const invalid = [
      { ...rugInput, images: [{ url: 'https://evil.example/rug.jpg' }] },
      { ...rugInput, images: [{ url: `http://${IMAGE_HOST}/rug.jpg` }] },
      { ...rugInput, price: 4500.5 },
      { ...rugInput, price: 50 },
      { ...rugInput, category: 'pottery' },
      { ...rugInput, attributes: { ...rugInput.attributes, material: 'polyester' } },
    ];

    for (const body of invalid) {
      expect((await call(seller, 'POST', '/seller/products', body)).statusCode).toBe(400);
    }
  });

  it('takes the shop from the token, never from the body', async () => {
    const { call } = await withProduct();

    const created = await call(seller, 'POST', '/seller/products', {
      ...rugInput,
      shopId: '0199f0a4-7a5b-7c1e-9f00-0000000000c9',
      status: 'PUBLISHED',
      sold: 1000,
    });
    expect(created.json()).toMatchObject({ shopId: sellerId, status: 'DRAFT', sold: 0 });
  });

  it('validates a change against the whole product', async () => {
    const { call, product } = await withProduct();

    const priced = await call(seller, 'PATCH', `/seller/products/${product.id}`, {
      price: 390_000,
    });
    expect(priced.json()).toMatchObject({ price: 390_000, slug: product.slug });

    // Changing the category alone leaves rug attributes on a pottery: refused.
    const mismatch = await call(seller, 'PATCH', `/seller/products/${product.id}`, {
      category: 'pottery',
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ detail: 'The product is not valid after this change' });

    const recategorized = await call(seller, 'PATCH', `/seller/products/${product.id}`, {
      category: 'pottery',
      attributes: { heightCm: 30, diameterCm: 25, material: 'terracotta', foodSafe: true },
    });
    expect(recategorized.json()).toMatchObject({ category: 'pottery' });
  });

  it('keeps every seller out of the products of the others (T2)', async () => {
    const { call, product } = await withProduct();
    await call(otherSeller, 'POST', '/seller/shop', { ...shopInput, name: 'Atelier Hassan' });

    expect((await call(otherSeller, 'GET', `/seller/products/${product.id}`)).statusCode).toBe(404);
    expect(
      (await call(otherSeller, 'PATCH', `/seller/products/${product.id}`, { price: 100 }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(otherSeller, 'POST', `/seller/products/${product.id}/status`, {
          status: 'ARCHIVED',
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(otherSeller, 'GET', '/seller/products')).json()).toMatchObject({ total: 0 });
  });

  it('explains why a product cannot be published', async () => {
    const { call, store, product } = await withProduct();
    const noImage = await call(seller, 'POST', '/seller/products', { ...rugInput, images: [] });
    const draft = noImage.json<{ id: string }>();

    const refused = await call(seller, 'POST', `/seller/products/${draft.id}/status`, {
      status: 'PUBLISHED',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'needs-images' });

    const shop = store.shops.get(sellerId);
    if (shop) shop.status = 'SUSPENDED';
    const suspended = await call(seller, 'POST', `/seller/products/${product.id}/status`, {
      status: 'PUBLISHED',
    });
    expect(suspended.json()).toMatchObject({ reason: 'shop-inactive' });

    await call(seller, 'POST', `/seller/products/${product.id}/status`, { status: 'ARCHIVED' });
    const fromArchive = await call(seller, 'POST', `/seller/products/${product.id}/status`, {
      status: 'PUBLISHED',
    });
    expect(fromArchive.json()).toMatchObject({ reason: 'invalid-transition' });
  });

  it('lists the products of the shop with a status filter', async () => {
    const { call, product } = await withProduct();
    await call(seller, 'POST', '/seller/products', rugInput);
    await call(seller, 'POST', `/seller/products/${product.id}/status`, { status: 'PUBLISHED' });

    expect((await call(seller, 'GET', '/seller/products')).json()).toMatchObject({ total: 2 });
    const published = await call(seller, 'GET', '/seller/products?status=PUBLISHED&perPage=1');
    expect(published.json()).toMatchObject({ total: 1, perPage: 1, items: [{ id: product.id }] });
  });

  it('needs a shop before the first product', async () => {
    const { call } = await setup();
    expect((await call(seller, 'POST', '/seller/products', rugInput)).statusCode).toBe(404);
  });
});

describe('products of a cart (US-04)', () => {
  it('returns the listed products among the identifiers, and leaves the others out', async () => {
    const { call, product } = await withProduct();
    const draft = (await call(seller, 'POST', '/seller/products', rugInput)).json<{ id: string }>();
    await call(seller, 'POST', `/seller/products/${product.id}/status`, { status: 'PUBLISHED' });
    const unknown = '0199f0a4-7a5b-7c1e-9f00-0000000000ff';

    const response = await call(
      visitor,
      'GET',
      `/products?ids=${product.id},${draft.id},${unknown},${product.id}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      product.id,
    ]);
  });

  it('bounds the lookup to 50 valid identifiers', async () => {
    const { call } = await setup();
    const ids = Array.from(
      { length: 51 },
      (_, index) => `0199f0a4-7a5b-7c1e-9f00-${String(index).padStart(12, '0')}`,
    );

    expect((await call(visitor, 'GET', `/products?ids=${ids.join(',')}`)).statusCode).toBe(400);
    expect((await call(visitor, 'GET', '/products?ids=not-a-uuid')).statusCode).toBe(400);
  });
});

describe('search (US-02)', () => {
  it('passes validated queries to the index', async () => {
    const { call, search } = await setup();

    const response = await call(
      visitor,
      'GET',
      '/search?q=tapis%20berbere&category=rug&city=marrakech&priceMax=500000&sort=price-asc&locale=ar',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 3, facets: { category: { rug: 3 } } });
    expect(search.queries[0]).toMatchObject({
      q: 'tapis berbere',
      category: 'rug',
      city: 'marrakech',
      priceMax: 500_000,
      sort: 'price-asc',
      locale: 'ar',
      page: 1,
    });
  });

  it('refuses free text in filters and unbounded pages', async () => {
    const { call } = await setup();

    for (const url of [
      '/search?city=marrakech%22%20OR%20shopId%20EXISTS',
      '/search?category=furniture',
      '/search?perPage=1000',
      '/search?q=' + 'x'.repeat(101),
      '/search?unknown=1',
    ]) {
      expect((await call(visitor, 'GET', url)).statusCode).toBe(400);
    }
  });
});
