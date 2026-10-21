import type { ProductStatus } from '@soukconnect/contracts';
import type { Product, Shop } from './model.js';

/** Status changes a seller may make; ARCHIVED products can come back as drafts. */
const TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export type StatusRefusal = 'invalid-transition' | 'needs-images' | 'shop-inactive';

/** Why a product cannot move to `target`, or null when it can. */
export function statusRefusal(
  product: Product,
  shop: Shop,
  target: ProductStatus,
): StatusRefusal | null {
  if (!TRANSITIONS[product.status].includes(target)) return 'invalid-transition';
  if (target === 'PUBLISHED') {
    if (product.images.length === 0) return 'needs-images';
    if (shop.status !== 'ACTIVE') return 'shop-inactive';
  }
  return null;
}

/** Visible to visitors, searchable and orderable. */
export function isListed(product: Pick<Product, 'status'>, shop: Pick<Shop, 'status'>): boolean {
  return product.status === 'PUBLISHED' && shop.status === 'ACTIVE';
}

/**
 * Quantities per product of a reservation: the same product may appear on several lines of the
 * cart; the reservation is checked and applied on the total.
 */
export function quantitiesOf(
  items: readonly { productId: string; quantity: number }[],
): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  return quantities;
}

export interface Unavailable {
  productId: string;
  requested: number;
  available: number;
}

/**
 * The products that cannot be reserved: unknown, not listed, or with too little stock. The
 * reservation is all or nothing: one unavailable product rejects the whole order.
 */
export function unavailableOf(
  quantities: ReadonlyMap<string, number>,
  products: ReadonlyMap<string, Product>,
  shops: ReadonlyMap<string, Shop>,
): Unavailable[] {
  const unavailable: Unavailable[] = [];
  for (const [productId, requested] of quantities) {
    const product = products.get(productId);
    const shop = product ? shops.get(product.shopId) : undefined;
    const available = product && shop && isListed(product, shop) ? product.stock : 0;
    if (available < requested) unavailable.push({ productId, requested, available });
  }
  return unavailable;
}
