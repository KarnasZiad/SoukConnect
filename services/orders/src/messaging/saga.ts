import type { Handlers, QueueSpec } from '@soukconnect/messaging';
import {
  onPaymentFailed,
  onPaymentSucceeded,
  onStockRejected,
  onStockReserved,
} from '../domain/saga.js';
import type { OrderStore } from '../ports.js';

/** The facts the orchestrator waits for, from catalog and payments. */
export const SAGA: QueueSpec = {
  queue: 'orders.saga',
  bindings: [
    'catalog.stock-reserved',
    'catalog.stock-rejected',
    'payments.payment-succeeded',
    'payments.payment-failed',
  ],
};

export function sagaHandlers(store: OrderStore): Handlers {
  return {
    'catalog.stock-reserved': (message) =>
      store.handle(message, (order, now) => onStockReserved(order, message.payload, now)),
    'catalog.stock-rejected': (message) =>
      store.handle(message, (order) => onStockRejected(order, message.payload)),
    'payments.payment-succeeded': (message) =>
      store.handle(message, (order) => onPaymentSucceeded(order, message.payload)),
    'payments.payment-failed': (message) =>
      store.handle(message, (order) => onPaymentFailed(order)),
  };
}
