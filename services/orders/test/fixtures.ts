import type { Line, Order } from '../src/domain/order.js';

export const buyerId = '0199f0a4-7a5b-7c1e-9f00-0000000000b1';
export const otherBuyerId = '0199f0a4-7a5b-7c1e-9f00-0000000000b2';
export const shopA = '0199f0a4-7a5b-7c1e-9f00-0000000000c1';
export const shopB = '0199f0a4-7a5b-7c1e-9f00-0000000000c2';
export const rugId = '0199f0a4-7a5b-7c1e-9f00-0000000000a1';
export const potId = '0199f0a4-7a5b-7c1e-9f00-0000000000a2';

export const address = {
  fullName: 'Amina El Idrissi',
  line1: '12 Derb Sidi Bouloukat',
  city: 'Marrakech',
  postalCode: '40000',
  country: 'MA' as const,
  phone: '+212 600 000 000',
};

export const lines: Line[] = [
  {
    productId: rugId,
    shopId: shopA,
    title: { fr: 'Tapis Beni Ouarain' },
    unitPrice: 450_000,
    quantity: 1,
    commissionBps: 1000,
  },
  {
    productId: potId,
    shopId: shopB,
    title: { fr: 'Tajine de Safi' },
    unitPrice: 25_000,
    quantity: 2,
    commissionBps: 800,
  },
];

export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: '0199f0a4-7a5b-7c1e-9f00-00000000000a',
    buyerId,
    status: 'PENDING',
    items: [
      { productId: rugId, quantity: 1 },
      { productId: potId, quantity: 2 },
    ],
    lines: [],
    total: null,
    currency: 'MAD',
    shippingAddress: address,
    paymentDeadline: null,
    cancellationReason: null,
    shipments: [],
    createdAt: new Date('2026-10-21T08:00:00Z'),
    updatedAt: new Date('2026-10-21T08:00:00Z'),
    ...overrides,
  };
}

/** An order whose stock is reserved, waiting for its payment. */
export function awaitingPayment(overrides: Partial<Order> = {}): Order {
  return order({
    status: 'AWAITING_PAYMENT',
    lines,
    total: 500_000,
    paymentDeadline: new Date('2026-10-21T08:15:00Z'),
    ...overrides,
  });
}

/** A paid order with one shipment per shop. */
export function confirmed(overrides: Partial<Order> = {}): Order {
  return awaitingPayment({
    status: 'CONFIRMED',
    paymentDeadline: null,
    shipments: [shopA, shopB].map((shopId) => ({
      shopId,
      status: 'PREPARING' as const,
      trackingNumber: null,
      shippedAt: null,
      deliveredAt: null,
    })),
    ...overrides,
  });
}
