import { type Handlers, PermanentError, type QueueSpec } from '@soukconnect/messaging';
import { assertShares } from '../domain/ledger.js';
import type { PaymentGateway, PaymentStore } from '../ports.js';

/** Commands of the saga, sent by orders. */
export const COMMANDS: QueueSpec = {
  queue: 'payments.commands',
  bindings: ['payments.request-payment', 'payments.cancel-payment', 'payments.refund-payment'],
};

/**
 * Each command acts at Stripe first, with an idempotency key, then records itself: a retry after
 * a crash repeats the Stripe call harmlessly instead of skipping it.
 */
export function commandHandlers(store: PaymentStore, gateway: PaymentGateway): Handlers {
  return {
    'payments.request-payment': async (command) => {
      const { orderId, amount, shares } = command.payload;
      assertShares(shares, amount);
      const existing = await store.findByOrder(orderId);
      if (existing) {
        if (existing.amount !== amount) {
          throw new PermanentError(`Order ${orderId} already has a payment of another amount`);
        }
        await store.markHandled(command);
        return;
      }
      const intent = await gateway.createIntent({ orderId, amount });
      await store.requestPayment(command, intent.id);
    },
    'payments.cancel-payment': async (command) => {
      const payment = await store.findByOrder(command.payload.orderId);
      // Its state comes back through the payment_intent.canceled webhook.
      if (payment?.status === 'REQUIRES_PAYMENT') await gateway.cancelIntent(payment.intentId);
      await store.markHandled(command);
    },
    'payments.refund-payment': async (command) => {
      const payment = await store.findByOrder(command.payload.orderId);
      if (!payment) throw new PermanentError(`No payment for order ${command.payload.orderId}`);
      // The ledger and the event follow the charge.refunded webhook.
      if (payment.status === 'SUCCEEDED') {
        await gateway.refund({ orderId: payment.orderId, intentId: payment.intentId });
      }
      await store.markHandled(command);
    },
  };
}
