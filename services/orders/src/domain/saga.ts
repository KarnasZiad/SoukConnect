import {
  type CancellationReason,
  type MessagePayload,
  type MessageType,
  type OrderStatus,
  sharesOf,
  totalOf,
} from '@soukconnect/contracts';
import { PermanentError } from '@soukconnect/messaging';
import type { Line, Order, Shipment } from './order.js';

/** The buyer has 15 minutes to pay; the stock stays reserved meanwhile (US-05). */
export const PAYMENT_WINDOW_MS = 15 * 60_000;

export type Outgoing = {
  [T in MessageType]: { type: T; payload: MessagePayload<T> };
}[MessageType];

/** What a saga step decides: the new state of the order and the messages to send with it. */
export interface Decision {
  status?: OrderStatus;
  lines?: Line[];
  total?: number;
  paymentDeadline?: Date | null;
  cancellationReason?: CancellationReason;
  shipments?: Shipment[];
  messages: Outgoing[];
}

const NOTHING: Decision = { messages: [] };

function outOfSequence(order: Order, step: string): never {
  throw new PermanentError(`Order ${order.id} is ${order.status}: ${step} is out of sequence`);
}

function sameQuantities(order: Order, lines: readonly Line[]): boolean {
  const asked = new Map<string, number>();
  for (const item of order.items) {
    asked.set(item.productId, (asked.get(item.productId) ?? 0) + item.quantity);
  }
  for (const line of lines) {
    const left = (asked.get(line.productId) ?? 0) - line.quantity;
    if (left < 0) return false;
    asked.set(line.productId, left);
  }
  return [...asked.values()].every((left) => left === 0);
}

function cancellation(order: Order, reason: CancellationReason): Outgoing {
  return {
    type: 'orders.order-cancelled',
    payload: { orderId: order.id, buyerId: order.buyerId, reason },
  };
}

function releaseStock(order: Order, reason: string): Outgoing {
  return { type: 'catalog.release-stock', payload: { orderId: order.id, reason } };
}

function cancelPayment(order: Order, reason: string): Outgoing {
  return { type: 'payments.cancel-payment', payload: { orderId: order.id, reason } };
}

/** The catalog reserved the stock: the order awaits its payment, at the frozen prices. */
export function onStockReserved(
  order: Order,
  reserved: MessagePayload<'catalog.stock-reserved'>,
  now: Date,
): Decision {
  if (order.status === 'CANCELLED') {
    // Cancelled by the buyer while the reservation was in flight: give the stock back.
    return { messages: [releaseStock(order, 'Order cancelled before payment')] };
  }
  if (order.status !== 'PENDING') return outOfSequence(order, 'stock-reserved');
  if (!sameQuantities(order, reserved.lines)) {
    throw new PermanentError(`Order ${order.id}: the reservation does not match the items`);
  }
  const total = totalOf(reserved.lines);
  return {
    status: 'AWAITING_PAYMENT',
    lines: reserved.lines,
    total,
    paymentDeadline: new Date(now.getTime() + PAYMENT_WINDOW_MS),
    messages: [
      {
        type: 'payments.request-payment',
        payload: {
          orderId: order.id,
          buyerId: order.buyerId,
          amount: total,
          currency: 'MAD',
          shares: sharesOf(reserved.lines),
        },
      },
    ],
  };
}

/** Some products were unavailable: nothing was reserved, so nothing needs compensating. */
export function onStockRejected(
  order: Order,
  rejected: MessagePayload<'catalog.stock-rejected'>,
): Decision {
  if (order.status === 'CANCELLED') return NOTHING;
  if (order.status !== 'PENDING') return outOfSequence(order, 'stock-rejected');
  return {
    status: 'REJECTED',
    messages: [
      {
        type: 'orders.order-rejected',
        payload: {
          orderId: order.id,
          buyerId: order.buyerId,
          unavailable: rejected.unavailable.map((entry) => entry.productId),
        },
      },
    ],
  };
}

/** Paid: confirm, commit the stock, and open one shipment per shop. */
export function onPaymentSucceeded(
  order: Order,
  paid: MessagePayload<'payments.payment-succeeded'>,
): Decision {
  if (order.status === 'CANCELLED') {
    // Paid after the deadline or after the buyer cancelled: the money goes back.
    return {
      messages: [
        {
          type: 'payments.refund-payment',
          payload: { orderId: order.id, reason: 'Paid after the order was cancelled' },
        },
      ],
    };
  }
  if (order.status === 'CONFIRMED' || order.status === 'FULFILLED') return NOTHING;
  if (order.status !== 'AWAITING_PAYMENT') return outOfSequence(order, 'payment-succeeded');
  if (paid.amount !== order.total) {
    throw new PermanentError(
      `Order ${order.id}: paid ${paid.amount}, expected ${String(order.total)}`,
    );
  }
  const shopIds = [...new Set(order.lines.map((line) => line.shopId))];
  return {
    status: 'CONFIRMED',
    paymentDeadline: null,
    shipments: shopIds.map((shopId) => ({
      shopId,
      status: 'PREPARING',
      trackingNumber: null,
      shippedAt: null,
      deliveredAt: null,
    })),
    messages: [
      { type: 'catalog.commit-stock', payload: { orderId: order.id } },
      {
        type: 'orders.order-confirmed',
        payload: {
          orderId: order.id,
          buyerId: order.buyerId,
          total: paid.amount,
          currency: 'MAD',
          shopIds,
        },
      },
    ],
  };
}

/** The payment can no longer succeed (cancelled at Stripe): release the stock. */
export function onPaymentFailed(order: Order): Decision {
  if (order.status === 'CANCELLED') return NOTHING;
  if (order.status !== 'AWAITING_PAYMENT') return outOfSequence(order, 'payment-failed');
  return {
    status: 'CANCELLED',
    paymentDeadline: null,
    cancellationReason: 'PAYMENT_FAILED',
    messages: [releaseStock(order, 'Payment failed'), cancellation(order, 'PAYMENT_FAILED')],
  };
}

/** The deadline passed without payment. */
export function expire(order: Order, now: Date): Decision {
  if (
    order.status !== 'AWAITING_PAYMENT' ||
    order.paymentDeadline === null ||
    order.paymentDeadline > now
  ) {
    return NOTHING;
  }
  return {
    status: 'CANCELLED',
    paymentDeadline: null,
    cancellationReason: 'PAYMENT_EXPIRED',
    messages: [
      releaseStock(order, 'Payment expired'),
      cancelPayment(order, 'Payment expired'),
      cancellation(order, 'PAYMENT_EXPIRED'),
    ],
  };
}

/** The buyer gives up before paying; a paid order is not cancelled here (returns are out of scope). */
export function cancelByBuyer(order: Order): Decision | 'not-cancellable' {
  if (order.status === 'PENDING') {
    // The reservation may still be in flight: its answer will release the stock (onStockReserved).
    return {
      status: 'CANCELLED',
      cancellationReason: 'BUYER_CANCELLED',
      messages: [cancellation(order, 'BUYER_CANCELLED')],
    };
  }
  if (order.status === 'AWAITING_PAYMENT') {
    return {
      status: 'CANCELLED',
      paymentDeadline: null,
      cancellationReason: 'BUYER_CANCELLED',
      messages: [
        releaseStock(order, 'Cancelled by the buyer'),
        cancelPayment(order, 'Cancelled by the buyer'),
        cancellation(order, 'BUYER_CANCELLED'),
      ],
    };
  }
  return 'not-cancellable';
}

export type ShipmentRefusal = 'not-found' | 'not-paid' | 'invalid-transition' | 'tracking-required';

/** A seller ships or delivers its part; the order is fulfilled once every part is delivered. */
export function updateShipment(
  order: Order,
  shopId: string,
  change: { status: 'SHIPPED' | 'DELIVERED'; trackingNumber?: string },
  now: Date,
): Decision | ShipmentRefusal {
  const shipment = order.shipments.find((entry) => entry.shopId === shopId);
  if (!shipment) return 'not-found';
  if (order.status !== 'CONFIRMED') return 'not-paid';
  const expected = change.status === 'SHIPPED' ? 'PREPARING' : 'SHIPPED';
  if (shipment.status !== expected) return 'invalid-transition';
  if (change.status === 'SHIPPED' && !change.trackingNumber) return 'tracking-required';

  const updated: Shipment = {
    ...shipment,
    status: change.status,
    trackingNumber: change.trackingNumber ?? shipment.trackingNumber,
    shippedAt: change.status === 'SHIPPED' ? now : shipment.shippedAt,
    deliveredAt: change.status === 'DELIVERED' ? now : shipment.deliveredAt,
  };
  const shipments = order.shipments.map((entry) => (entry.shopId === shopId ? updated : entry));
  return {
    ...(shipments.every((entry) => entry.status === 'DELIVERED') ? { status: 'FULFILLED' } : {}),
    shipments,
    messages: [
      {
        type: 'orders.shipment-updated',
        payload: {
          orderId: order.id,
          buyerId: order.buyerId,
          shopId,
          status: updated.status,
          trackingNumber: updated.trackingNumber,
        },
      },
    ],
  };
}
