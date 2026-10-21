import {
  CANCELLATION_REASONS,
  LOCALES,
  ORDER_STATUSES,
  SHIPMENT_STATUSES,
} from '@soukconnect/contracts';
import { z } from 'zod';
import { type Order, type Shipment, shippingAddressSchema } from '../domain/order.js';
import type { SellerOrder, SellerStats } from '../ports.js';

/** The buyer sends identifiers and quantities only: prices come from the catalog (T1). */
export const newOrderSchema = z
  .object({
    items: z
      .array(z.object({ productId: z.uuid(), quantity: z.int().min(1).max(99) }).strict())
      .min(1)
      .max(50),
    shippingAddress: shippingAddressSchema,
  })
  .strict();

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const text = z.object(Object.fromEntries(LOCALES.map((locale) => [locale, z.string().optional()])));

const lineView = z.object({
  productId: z.uuid(),
  shopId: z.uuid(),
  title: text,
  unitPrice: z.int(),
  quantity: z.int(),
});

const shipmentView = z.object({
  shopId: z.uuid(),
  status: z.enum(SHIPMENT_STATUSES),
  trackingNumber: z.string().nullable(),
  shippedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
});

export const orderView = z.object({
  id: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  items: z.array(z.object({ productId: z.uuid(), quantity: z.int() })),
  lines: z.array(lineView),
  total: z.int().nullable(),
  currency: z.literal('MAD'),
  shippingAddress: shippingAddressSchema,
  paymentDeadline: z.iso.datetime().nullable(),
  cancellationReason: z.enum(CANCELLATION_REASONS).nullable(),
  shipments: z.array(shipmentView),
  createdAt: z.iso.datetime(),
});

export const sellerOrderView = z.object({
  orderId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  lines: z.array(lineView),
  subtotal: z.int(),
  commission: z.int(),
  shipment: shipmentView,
  shippingAddress: shippingAddressSchema,
  createdAt: z.iso.datetime(),
});

export const statsView = z.object({
  days: z.int(),
  orders: z.int(),
  revenue: z.int(),
  commission: z.int(),
  net: z.int(),
  averageOrder: z.int(),
  topProducts: z.array(
    z.object({ productId: z.uuid(), title: text, quantity: z.int(), revenue: z.int() }),
  ),
});

const iso = (date: Date | null) => date?.toISOString() ?? null;

function toShipmentView(shipment: Shipment): z.infer<typeof shipmentView> {
  return {
    shopId: shipment.shopId,
    status: shipment.status,
    trackingNumber: shipment.trackingNumber,
    shippedAt: iso(shipment.shippedAt),
    deliveredAt: iso(shipment.deliveredAt),
  };
}

/** Commission rates are internal to the platform: the buyer never sees them. */
export function toOrderView(order: Order): z.infer<typeof orderView> {
  return {
    id: order.id,
    status: order.status,
    items: order.items,
    lines: order.lines.map(({ commissionBps: _rate, ...line }) => line),
    total: order.total,
    currency: order.currency,
    shippingAddress: order.shippingAddress,
    paymentDeadline: iso(order.paymentDeadline),
    cancellationReason: order.cancellationReason,
    shipments: order.shipments.map(toShipmentView),
    createdAt: order.createdAt.toISOString(),
  };
}

export function toSellerOrderView(order: SellerOrder): z.infer<typeof sellerOrderView> {
  return {
    orderId: order.orderId,
    status: order.status,
    lines: order.lines.map(({ commissionBps: _rate, ...line }) => line),
    subtotal: order.subtotal,
    commission: order.commission,
    shipment: toShipmentView(order.shipment),
    shippingAddress: order.shippingAddress,
    createdAt: order.createdAt.toISOString(),
  };
}

export function toStatsView(days: number, stats: SellerStats): z.infer<typeof statsView> {
  return { days, ...stats };
}
