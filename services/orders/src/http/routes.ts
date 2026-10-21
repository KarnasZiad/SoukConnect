import { createHash } from 'node:crypto';
import {
  badRequest,
  conflict,
  type createService,
  notFound,
  ProblemError,
  requireShop,
  requireUser,
} from '@soukconnect/service-kit';
import { z } from 'zod';
import type { OrderStore } from '../ports.js';
import {
  idempotencyKeySchema,
  newOrderSchema,
  orderView,
  sellerOrderView,
  statsView,
  toOrderView,
  toSellerOrderView,
  toStatsView,
} from './schemas.js';

type App = Awaited<ReturnType<typeof createService>>;

const idParams = z.object({ id: z.uuid() }).strict();
const page = {
  page: z.coerce.number().int().min(1).max(1000).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
};

const SHIPMENT_REFUSALS = {
  'not-paid': 'Only a paid order can be shipped',
  'invalid-transition': 'A shipment goes from preparing to shipped, then to delivered',
  'tracking-required': 'A tracking number is required to mark the parcel as shipped',
} as const;

export function registerRoutes(
  app: App,
  store: OrderStore,
  now: () => Date = () => new Date(),
): void {
  // ---- Buyer (US-05, US-07)

  app.post(
    '/orders',
    {
      schema: {
        tags: ['buyer'],
        headers: z.object({ 'idempotency-key': idempotencyKeySchema }).loose(),
        body: newOrderSchema,
        response: { 200: orderView, 202: orderView },
      },
    },
    async (request, reply) => {
      const { userId } = requireUser(request, 'buyer');
      const result = await store.create({
        buyerId: userId,
        idempotencyKey: request.headers['idempotency-key'],
        // Zod rebuilds the body in schema order: equal requests have equal digests.
        requestHash: createHash('sha256').update(JSON.stringify(request.body)).digest('hex'),
        items: request.body.items,
        shippingAddress: request.body.shippingAddress,
      });
      if (result === 'key-reused') {
        throw new ProblemError(
          422,
          'Unprocessable Content',
          'This idempotency key was used for another order',
        );
      }
      if (result === 'too-many-active') {
        throw new ProblemError(429, 'Too Many Requests', 'Pay or cancel your pending orders first');
      }
      // 202: the stock is being reserved; the order moves on asynchronously.
      return reply.code(result.created ? 202 : 200).send(toOrderView(result.order));
    },
  );

  app.get(
    '/orders',
    {
      schema: {
        tags: ['buyer'],
        querystring: z.object(page).strict(),
        response: {
          200: z.object({
            items: z.array(orderView),
            total: z.int(),
            page: z.int(),
            perPage: z.int(),
          }),
        },
      },
    },
    async (request) => {
      const { userId } = requireUser(request, 'buyer');
      const result = await store.listForBuyer(userId, request.query.page, request.query.perPage);
      return { ...result, items: result.items.map(toOrderView) };
    },
  );

  app.get(
    '/orders/:id',
    { schema: { tags: ['buyer'], params: idParams, response: { 200: orderView } } },
    async (request) => {
      const { userId } = requireUser(request, 'buyer');
      // Another buyer's order answers like an order that does not exist (I1).
      const order = await store.getForBuyer(userId, request.params.id);
      if (!order) throw notFound();
      return toOrderView(order);
    },
  );

  app.post(
    '/orders/:id/cancel',
    { schema: { tags: ['buyer'], params: idParams, response: { 200: orderView } } },
    async (request) => {
      const { userId } = requireUser(request, 'buyer');
      const result = await store.cancel(userId, request.params.id);
      if (result === null) throw notFound();
      if (result === 'not-cancellable') throw conflict('This order can no longer be cancelled');
      return toOrderView(result);
    },
  );

  // ---- Seller (US-10, US-11)

  app.get(
    '/seller/orders',
    {
      schema: {
        tags: ['seller'],
        querystring: z
          .object({ status: z.enum(['CONFIRMED', 'FULFILLED']).optional(), ...page })
          .strict(),
        response: {
          200: z.object({
            items: z.array(sellerOrderView),
            total: z.int(),
            page: z.int(),
            perPage: z.int(),
          }),
        },
      },
    },
    async (request) => {
      const result = await store.listForShop(requireShop(request), request.query);
      return { ...result, items: result.items.map(toSellerOrderView) };
    },
  );

  app.post(
    '/seller/orders/:id/shipment',
    {
      schema: {
        tags: ['seller'],
        params: idParams,
        body: z
          .object({
            status: z.enum(['SHIPPED', 'DELIVERED']),
            trackingNumber: z
              .string()
              .trim()
              .regex(/^[A-Za-z0-9-]{4,64}$/)
              .optional(),
          })
          .strict(),
        response: { 200: sellerOrderView },
      },
    },
    async (request) => {
      const shopId = requireShop(request);
      const result = await store.updateShipment(shopId, request.params.id, request.body);
      // An order without a shipment of this shop is somebody else's: not found (I1).
      if (result === 'not-found') throw notFound();
      if (typeof result === 'string') throw conflict(SHIPMENT_REFUSALS[result], { reason: result });
      const view = (await store.listForShop(shopId, { page: 1, perPage: 50 })).items.find(
        (entry) => entry.orderId === result.id,
      );
      if (!view) throw notFound();
      return toSellerOrderView(view);
    },
  );

  app.get(
    '/seller/stats',
    {
      schema: {
        tags: ['seller'],
        querystring: z.object({ days: z.enum(['7', '30', '90']).default('30') }).strict(),
        response: { 200: statsView },
      },
    },
    async (request) => {
      const shopId = requireShop(request);
      const days = Number(request.query.days);
      if (!Number.isInteger(days)) throw badRequest();
      const since = new Date(now().getTime() - days * 24 * 3600 * 1000);
      return toStatsView(days, await store.statsForShop(shopId, since));
    },
  );
}
