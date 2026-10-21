import {
  badRequest,
  type createService,
  notFound,
  requireShop,
  requireUser,
} from '@soukconnect/service-kit';
import { z } from 'zod';
import type { PaymentGateway, PaymentStore } from '../ports.js';

type App = Awaited<ReturnType<typeof createService>>;

export interface RouteDeps {
  store: PaymentStore;
  gateway: PaymentGateway;
  now?: () => Date;
}

export function registerRoutes(app: App, deps: RouteDeps): void {
  const { store, gateway } = deps;
  const now = deps.now ?? (() => new Date());

  // ---- Stripe webhooks (US-06): the source of truth of a payment, never the browser redirect

  void app.register((scope, _options, done) => {
    // The signature covers the exact bytes Stripe sent: the body must not be parsed first.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    scope.post(
      '/webhooks/stripe',
      {
        bodyLimit: 512 * 1024,
        schema: {
          tags: ['stripe'],
          headers: z.object({ 'stripe-signature': z.string().min(1).max(1000) }).loose(),
          response: { 200: z.object({ received: z.literal(true), outcome: z.string() }) },
        },
      },
      async (request) => {
        const signature = request.headers['stripe-signature'];
        if (typeof signature !== 'string' || !Buffer.isBuffer(request.body)) {
          throw badRequest('A signed JSON body is required');
        }
        let event;
        try {
          event = gateway.verifyEvent(request.body, signature);
        } catch (error) {
          request.log.warn({ err: error }, 'Stripe webhook refused');
          throw badRequest('Invalid signature');
        }
        // A success of one of our payments is checked again with Stripe: amount and currency
        // must match (S3). If Stripe cannot be reached, the 500 makes Stripe retry the webhook.
        const known =
          event.type === 'payment_intent.succeeded' && event.intentId
            ? await store.findByIntent(event.intentId)
            : null;
        const checked = known ? await gateway.retrieve(known.intentId) : null;
        const outcome = await store.applyEvent(event, checked);
        request.log.info(
          { eventId: event.id, type: event.type, outcome },
          'Stripe webhook handled',
        );
        return { received: true as const, outcome };
      },
    );
    done();
  });

  // ---- Buyer: what Stripe Elements needs to confirm the payment in the browser

  app.get(
    '/orders/:orderId/payment',
    {
      schema: {
        tags: ['buyer'],
        params: z.object({ orderId: z.uuid() }).strict(),
        response: {
          200: z.object({
            status: z.enum(['REQUIRES_PAYMENT', 'SUCCEEDED', 'CANCELLED', 'REFUNDED']),
            amount: z.int(),
            currency: z.literal('MAD'),
            clientSecret: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { userId } = requireUser(request, 'buyer');
      const payment = await store.findByOrder(request.params.orderId);
      // Another buyer's payment answers like a payment that does not exist (I1).
      if (payment?.buyerId !== userId) throw notFound();
      const clientSecret =
        payment.status === 'REQUIRES_PAYMENT'
          ? (await gateway.retrieve(payment.intentId)).clientSecret
          : null;
      return {
        status: payment.status,
        amount: payment.amount,
        currency: 'MAD' as const,
        clientSecret,
      };
    },
  );

  // ---- Seller (US-13): what the shop earned, net of the commission

  app.get(
    '/seller/balance',
    {
      schema: {
        tags: ['seller'],
        querystring: z.object({ days: z.enum(['7', '30', '90', '365']).default('30') }).strict(),
        response: {
          200: z.object({
            days: z.int(),
            sales: z.int(),
            commission: z.int(),
            refunds: z.int(),
            net: z.int(),
          }),
        },
      },
    },
    async (request) => {
      const shopId = requireShop(request);
      const days = Number(request.query.days);
      const since = new Date(now().getTime() - days * 24 * 3600 * 1000);
      return { days, ...(await store.balanceOf(shopId, since)) };
    },
  );
}
