import type {
  CancellationReason,
  LocalizedText,
  OrderStatus,
  ShipmentStatus,
} from '@soukconnect/contracts';
import { z } from 'zod';

export interface Item {
  productId: string;
  quantity: number;
}

/** A line as reserved by the catalog: price, title and commission rate are frozen. */
export interface Line {
  productId: string;
  shopId: string;
  title: LocalizedText;
  unitPrice: number;
  quantity: number;
  commissionBps: number;
}

export interface Shipment {
  shopId: string;
  status: ShipmentStatus;
  trackingNumber: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
}

/** Countries the artisans ship to (ISO 3166-1 alpha-2). */
export const SHIPPING_COUNTRIES = [
  'MA',
  'FR',
  'BE',
  'ES',
  'DE',
  'NL',
  'IT',
  'GB',
  'US',
  'CA',
] as const;

export const shippingAddressSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(2).max(80),
    postalCode: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z -]{3,10}$/),
    country: z.enum(SHIPPING_COUNTRIES),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ]{8,20}$/),
  })
  .strict();
export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export interface Order {
  id: string;
  buyerId: string;
  status: OrderStatus;
  /** What the buyer asked for. */
  items: Item[];
  /** What the catalog reserved; empty until then. */
  lines: Line[];
  total: number | null;
  currency: 'MAD';
  shippingAddress: ShippingAddress;
  paymentDeadline: Date | null;
  cancellationReason: CancellationReason | null;
  shipments: Shipment[];
  createdAt: Date;
  updatedAt: Date;
}
