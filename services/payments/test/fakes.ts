import { createEnvelope, type Envelope, uuidv7 } from '@soukconnect/contracts';
import {
  createInternalVerifier,
  createLogger,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
  signInternalToken,
  type Actor,
} from '@soukconnect/service-kit';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { decide } from '../src/domain/events.js';
import { type Balance, balanceOf, type Entry } from '../src/domain/ledger.js';
import type {
  Payment,
  PaymentGateway,
  PaymentStore,
  WebhookEvent,
  WebhookOutcome,
} from '../src/ports.js';
import { normalize, WEBHOOK_TOLERANCE_SECONDS } from '../src/stripe/stripe-gateway.js';

export const WEBHOOK_SECRET = 'whsec_testsecret';
export const buyerId = '0199f0a4-7a5b-7c1e-9f00-0000000000b1';
export const shopA = '0199f0a4-7a5b-7c1e-9f00-0000000000c1';
export const shopB = '0199f0a4-7a5b-7c1e-9f00-0000000000c2';

/** The Stripe SDK without a client: only its webhook signing and verification, offline. */
const offline = new Stripe('sk_test_offline');

/**
 * Stripe in memory. Webhook signatures are real: the same SDK functions sign the test payloads
 * and verify them, so a forged or stale event is refused exactly as in production.
 */
export class FakeGateway implements PaymentGateway {
  intents = new Map<
    string,
    { orderId: string; amount: number; status: string; amountReceived: number }
  >();
  cancelled: string[] = [];
  refunds: string[] = [];
  createCalls = 0;

  createIntent(input: { orderId: string; amount: number }) {
    this.createCalls += 1;
    const existing = [...this.intents.entries()].find(
      ([, intent]) => intent.orderId === input.orderId,
    );
    if (existing) return Promise.resolve({ id: existing[0] });
    const id = `pi_${input.orderId.replaceAll('-', '').slice(0, 24)}`;
    this.intents.set(id, { ...input, status: 'requires_payment_method', amountReceived: 0 });
    return Promise.resolve({ id });
  }

  cancelIntent(intentId: string): Promise<void> {
    this.cancelled.push(intentId);
    return Promise.resolve();
  }

  refund(input: { orderId: string; intentId: string }): Promise<void> {
    this.refunds.push(input.intentId);
    return Promise.resolve();
  }

  retrieve(intentId: string) {
    const intent = this.intents.get(intentId);
    if (!intent) return Promise.reject(new Error('No such intent'));
    return Promise.resolve({
      status: intent.status,
      amountReceived: intent.amountReceived,
      currency: 'mad',
      clientSecret: `${intentId}_secret_test`,
    });
  }

  /** What Stripe does when the buyer pays: the intent succeeds with the amount received. */
  pay(intentId: string, amountReceived?: number): void {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error('No such intent');
    intent.status = 'succeeded';
    intent.amountReceived = amountReceived ?? intent.amount;
  }

  verifyEvent(rawBody: Buffer, signature: string): WebhookEvent {
    return normalize(
      offline.webhooks.constructEvent(
        rawBody,
        signature,
        WEBHOOK_SECRET,
        WEBHOOK_TOLERANCE_SECONDS,
      ),
    );
  }
}

/** A signed webhook request as Stripe sends it. */
export function signedEvent(
  type: string,
  object: Record<string, unknown>,
  options: { id?: string; timestamp?: number; secret?: string } = {},
) {
  const payload = JSON.stringify({
    id: options.id ?? `evt_${uuidv7().replaceAll('-', '')}`,
    object: 'event',
    type,
    data: { object },
  });
  const signature = offline.webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? WEBHOOK_SECRET,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
  return { payload, signature };
}

/** Payments and ledger in memory, with the same decisions as the PostgreSQL store. */
export class MemoryPaymentStore implements PaymentStore {
  payments = new Map<string, Payment>();
  handled = new Set<string>();
  events = new Set<string>();
  entries: (Entry & { createdAt: Date })[] = [];
  sent: { type: string; payload: unknown }[] = [];

  requestPayment(command: Envelope<'payments.request-payment'>, intentId: string): Promise<void> {
    if (this.handled.has(command.id)) return Promise.resolve();
    this.handled.add(command.id);
    const { orderId, buyerId: buyer, amount, shares } = command.payload;
    if (!this.findSync(orderId)) {
      const id = uuidv7();
      this.payments.set(id, {
        id,
        orderId,
        buyerId: buyer,
        intentId,
        amount,
        currency: 'MAD',
        status: 'REQUIRES_PAYMENT',
        shares,
        lastError: null,
      });
    }
    return Promise.resolve();
  }

  markHandled(command: Envelope): Promise<boolean> {
    if (this.handled.has(command.id)) return Promise.resolve(false);
    this.handled.add(command.id);
    return Promise.resolve(true);
  }

  private findSync(orderId: string) {
    return [...this.payments.values()].find((payment) => payment.orderId === orderId) ?? null;
  }

  findByOrder(orderId: string): Promise<Payment | null> {
    return Promise.resolve(this.findSync(orderId));
  }

  findByIntent(intentId: string): Promise<Payment | null> {
    return Promise.resolve(
      [...this.payments.values()].find((payment) => payment.intentId === intentId) ?? null,
    );
  }

  applyEvent(
    event: WebhookEvent,
    checked: { amountReceived: number; currency: string } | null,
  ): Promise<WebhookOutcome> {
    if (this.events.has(event.id)) return Promise.resolve('duplicate');
    this.events.add(event.id);
    const payment = [...this.payments.values()].find((entry) => entry.intentId === event.intentId);
    if (!payment) return Promise.resolve('ignored');
    const decision = decide(payment, event, checked);
    if (decision.kind === 'ignore') return Promise.resolve('ignored');
    if (decision.kind === 'error') {
      payment.lastError = decision.message;
      return Promise.resolve('ignored');
    }
    payment.status = decision.status;
    this.entries.push(...decision.entries.map((entry) => ({ ...entry, createdAt: new Date() })));
    this.sent.push(decision.message);
    return Promise.resolve('applied');
  }

  balanceOf(shopId: string, since: Date): Promise<Balance> {
    return Promise.resolve(
      balanceOf(
        this.entries.filter((entry) => entry.shopId === shopId && entry.createdAt >= since),
      ),
    );
  }
}

export function requestPayment(orderId: string = uuidv7(), amount = 500_000) {
  return createEnvelope(
    'payments.request-payment',
    {
      orderId,
      buyerId,
      amount,
      currency: 'MAD',
      shares: [
        { shopId: shopA, amount: 450_000, commissionBps: 1000 },
        { shopId: shopB, amount: amount - 450_000, commissionBps: 800 },
      ],
    },
    { correlationId: orderId },
  );
}

/** The payments API on in-memory adapters, with real internal tokens. */
export async function testApp() {
  const { privateJwk, publicJwk } = await generateSigningKeys('test');
  const key = await importSigningKey(JSON.stringify(privateJwk));
  const store = new MemoryPaymentStore();
  const gateway = new FakeGateway();
  const app = await buildApp({
    logger: createLogger('payments-test', 'silent'),
    store,
    gateway,
    verifyToken: createInternalVerifier({
      audience: 'payments',
      publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
    }),
  });
  const token = (actor: Actor) => signInternalToken(key, 'payments', actor);
  async function call(actor: Actor, method: 'GET' | 'POST', url: string) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${await token(actor)}` } });
  }
  /** Stripe calls the webhook through the gateway, which attaches a visitor token. */
  async function webhook(event: { payload: string; signature: string }) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: {
        authorization: `Bearer ${await token({ userId: null, role: 'visitor', shopId: null })}`,
        'content-type': 'application/json',
        'stripe-signature': event.signature,
      },
      payload: event.payload,
    });
  }
  return { app, store, gateway, call, webhook };
}
