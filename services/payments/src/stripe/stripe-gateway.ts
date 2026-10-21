import Stripe from 'stripe';
import type { PaymentGateway, WebhookEvent } from '../ports.js';

/** Five minutes: an older signed event is refused (replay protection, US-06). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Stripe events reduced to the PaymentIntent they are about. */
export function normalize(event: Stripe.Event): WebhookEvent {
  const object = event.data.object as {
    object?: string;
    id?: string;
    payment_intent?: string | { id: string } | null;
    last_payment_error?: { message?: string } | null;
  };
  let intentId: string | null = null;
  if (object.object === 'payment_intent' && typeof object.id === 'string') intentId = object.id;
  if (object.object === 'charge') {
    const intent = object.payment_intent;
    intentId = typeof intent === 'string' ? intent : (intent?.id ?? null);
  }
  return {
    id: event.id,
    type: event.type,
    intentId,
    failureMessage: object.last_payment_error?.message?.slice(0, 200) ?? null,
  };
}

export class StripeGateway implements PaymentGateway {
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
  ) {}

  async createIntent(input: { orderId: string; amount: number }) {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amount,
        currency: 'mad',
        automatic_payment_methods: { enabled: true },
        metadata: { orderId: input.orderId },
      },
      // Retries of the same command return the same intent instead of charging twice.
      { idempotencyKey: `payment-intent:${input.orderId}` },
    );
    return { id: intent.id };
  }

  async cancelIntent(intentId: string): Promise<void> {
    try {
      await this.stripe.paymentIntents.cancel(intentId);
    } catch (error) {
      // Already succeeded or cancelled: the webhook carries the final state.
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === 'payment_intent_unexpected_state'
      ) {
        return;
      }
      throw error;
    }
  }

  async refund(input: { orderId: string; intentId: string }): Promise<void> {
    await this.stripe.refunds.create(
      { payment_intent: input.intentId, metadata: { orderId: input.orderId } },
      { idempotencyKey: `refund:${input.orderId}` },
    );
  }

  async retrieve(intentId: string) {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    return {
      status: intent.status,
      amountReceived: intent.amount_received,
      currency: intent.currency,
      clientSecret: intent.client_secret,
    };
  }

  verifyEvent(rawBody: Buffer, signature: string): WebhookEvent {
    return normalize(
      this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
        WEBHOOK_TOLERANCE_SECONDS,
      ),
    );
  }
}
