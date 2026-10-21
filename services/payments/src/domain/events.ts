import type { MessagePayload } from '@soukconnect/contracts';
import type { Payment, PaymentStatus, WebhookEvent } from '../ports.js';
import { type Entry, refundEntries, saleEntries } from './ledger.js';

/** What a verified Stripe event changes: the payment, its ledger entries, the message to orders. */
export type EventDecision =
  | { kind: 'ignore' }
  | { kind: 'error'; message: string }
  | {
      kind: 'change';
      status: PaymentStatus;
      entries: Entry[];
      message:
        | {
            type: 'payments.payment-succeeded';
            payload: MessagePayload<'payments.payment-succeeded'>;
          }
        | { type: 'payments.payment-failed'; payload: MessagePayload<'payments.payment-failed'> }
        | {
            type: 'payments.payment-refunded';
            payload: MessagePayload<'payments.payment-refunded'>;
          };
    };

export function decide(
  payment: Payment,
  event: WebhookEvent,
  checked: { amountReceived: number; currency: string } | null,
): EventDecision {
  const ids = { orderId: payment.orderId, paymentId: payment.id };
  switch (event.type) {
    case 'payment_intent.succeeded': {
      if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED')
        return { kind: 'ignore' };
      // The event says succeeded; Stripe, asked again, must agree on the amount and currency.
      if (checked?.amountReceived !== payment.amount || checked.currency.toLowerCase() !== 'mad') {
        return { kind: 'error', message: 'Amount received does not match the payment' };
      }
      // Even for a cancelled payment: the money was taken, orders decides to refund it.
      return {
        kind: 'change',
        status: 'SUCCEEDED',
        entries: saleEntries(payment.shares, payment.amount),
        message: {
          type: 'payments.payment-succeeded',
          payload: { ...ids, amount: payment.amount, currency: 'MAD' },
        },
      };
    }
    case 'payment_intent.canceled':
      if (payment.status !== 'REQUIRES_PAYMENT') return { kind: 'ignore' };
      return {
        kind: 'change',
        status: 'CANCELLED',
        entries: [],
        message: { type: 'payments.payment-failed', payload: { ...ids, reason: 'canceled' } },
      };
    case 'payment_intent.payment_failed':
      // A declined card: the buyer may try another one before the deadline.
      return { kind: 'error', message: event.failureMessage ?? 'Payment attempt failed' };
    case 'charge.refunded':
      if (payment.status !== 'SUCCEEDED') return { kind: 'ignore' };
      return {
        kind: 'change',
        status: 'REFUNDED',
        entries: refundEntries(payment.shares),
        message: {
          type: 'payments.payment-refunded',
          payload: { ...ids, amount: payment.amount, currency: 'MAD' },
        },
      };
    default:
      return { kind: 'ignore' };
  }
}
