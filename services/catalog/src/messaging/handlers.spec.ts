import { createEnvelope } from '@soukconnect/contracts';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCatalogStore, rugInput, sellerId, shopInput } from '../../test/fakes.js';
import { commandHandlers, indexerHandlers } from './handlers.js';

const orderId = '0199f0a4-7a5b-7c1e-9f00-00000000000a';
const context = { attempt: 0, redelivered: false };

describe('command handlers', () => {
  it('hand each command of the saga to the stock ledger', async () => {
    const stock = {
      reserve: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => Promise.resolve()),
      commit: vi.fn(() => Promise.resolve()),
    };
    const handlers = commandHandlers(stock);
    const reserve = createEnvelope(
      'catalog.reserve-stock',
      { orderId, items: [{ productId: orderId, quantity: 1 }] },
      { correlationId: orderId },
    );
    const release = createEnvelope(
      'catalog.release-stock',
      { orderId, reason: 'Payment expired' },
      { correlationId: orderId },
    );
    const commit = createEnvelope('catalog.commit-stock', { orderId }, { correlationId: orderId });

    await handlers['catalog.reserve-stock']?.(reserve, context);
    await handlers['catalog.release-stock']?.(release, context);
    await handlers['catalog.commit-stock']?.(commit, context);

    expect(stock.reserve).toHaveBeenCalledWith(reserve);
    expect(stock.release).toHaveBeenCalledWith(release);
    expect(stock.commit).toHaveBeenCalledWith(commit);
  });
});

describe('indexer', () => {
  async function setup() {
    const store = new MemoryCatalogStore();
    const shop = await store.createShop(sellerId, shopInput);
    if (shop === 'exists') throw new Error('unreachable');
    shop.status = 'ACTIVE';
    const product = await store.createProduct(shop, rugInput);
    const index = {
      upsert: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    const handler = indexerHandlers(store, index)['catalog.product-changed'];
    const changed = () =>
      createEnvelope(
        'catalog.product-changed',
        { productId: product.id, shopId: shop.id, slug: product.slug, status: product.status },
        { correlationId: product.id },
      );
    return { store, shop, product, index, handler, changed };
  }

  it('indexes a listed product from its current state, not from the event', async () => {
    const { store, shop, product, index, handler, changed } = await setup();
    const event = changed(); // emitted while it was a draft
    await store.setProductStatus(shop, product.id, 'PUBLISHED');

    await handler?.(event, context);

    expect(index.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ id: product.id, inStock: true }),
    ]);
  });

  it('removes a product that is no longer listed, or no longer exists', async () => {
    const { store, shop, product, index, handler, changed } = await setup();

    await handler?.(changed(), context);
    expect(index.remove).toHaveBeenCalledWith(product.id);

    await store.setProductStatus(shop, product.id, 'PUBLISHED');
    shop.status = 'SUSPENDED';
    await handler?.(changed(), context);
    store.products.clear();
    await handler?.(changed(), context);

    expect(index.remove).toHaveBeenCalledTimes(3);
    expect(index.upsert).not.toHaveBeenCalled();
  });
});
