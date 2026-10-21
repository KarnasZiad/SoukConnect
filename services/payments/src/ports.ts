import type { Envelope, Share } from '@soukconnect/contracts';
import type { Balance } from './domain/ledger.js';

export type PaymentStatus = 'REQUIRES_PAYMENT' | 'SUCCEEDED' | 'CANCELLED' | 'REFUNDED';

export interface Payment {
  id: string;
  orderId: string;
  buyerId: string;
  intentId: string;
  amount: number;
  currency: 'MAD';
  status: PaymentStatus;
  shares: Share[];
  lastError: string | null;
}

/** A verified Stripe event, reduced to what the service uses. */
export interface WebhookEvent {
  id: string;
  type: string;
  intentId: string | null;
  failureMessage: string | null;
}

/** Stripe behind an interface: the tests use a fake, production the SDK. */
export interface PaymentGateway {
  /** Idempotent per order: a retry returns the same PaymentIntent. */
  createIntent(input: { orderId: string; amount: number }): Promise<{ id: string }>;
  /** No-op when the intent can no longer be cancelled (already succeeded or cancelled). */
  cancelIntent(intentId: string): Promise<void>;
  /** Idempotent per order. */
  refund(input: { orderId: string; intentId: string }): Promise<void>;
  /** The state Stripe holds, read again before trusting a success (S3). */
  retrieve(intentId: string): Promise<{
    status: string;
    amountReceived: number;
    currency: string;
    clientSecret: string | null;
  }>;
  /** Throws when the signature is missing, wrong, or older than five minutes. */
  verifyEvent(rawBody: Buffer, signature: string): WebhookEvent;
}

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored';

export interface PaymentStore {
  /** Records the PaymentIntent of an order, once (inbox). */
  requestPayment(command: Envelope<'payments.request-payment'>, intentId: string): Promise<void>;
  /** Marks a command whose effect happened at Stripe; false if it was handled before. */
  markHandled(command: Envelope): Promise<boolean>;
  findByOrder(orderId: string): Promise<Payment | null>;
  findByIntent(intentId: string): Promise<Payment | null>;
  /** Applies a verified Stripe event once: state, ledger and outgoing message together. */
  applyEvent(
    event: WebhookEvent,
    checked: { amountReceived: number; currency: string } | null,
  ): Promise<WebhookOutcome>;
  balanceOf(shopId: string, since: Date): Promise<Balance>;
}
