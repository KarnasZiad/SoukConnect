/** States of an order, driven by the saga in the orders service (docs/architecture/saga.md). */
export const ORDER_STATUSES = [
  'PENDING',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'FULFILLED',
  'REJECTED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Each shop of an order ships on its own. */
export const SHIPMENT_STATUSES = ['PREPARING', 'SHIPPED', 'DELIVERED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const PRODUCT_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const CANCELLATION_REASONS = [
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
  'BUYER_CANCELLED',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const ROLES = ['buyer', 'seller', 'moderator'] as const;
export type Role = (typeof ROLES)[number];
