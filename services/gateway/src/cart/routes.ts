import { type createService, forbidden, ProblemError } from '@soukconnect/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorOf, requireSession } from '../http/context.js';
import type { InternalClient } from '../proxy/internal-client.js';
import { type Cart, type CartStore, MAX_QUANTITY } from './cart-store.js';

type App = Awaited<ReturnType<typeof createService>>;

export interface CartDeps {
  carts: CartStore;
  internal: InternalClient;
}

/** The product as the catalog shows it to visitors: only what the cart displays is read. */
interface CatalogProduct {
  id: string;
  slug: string;
  title: Partial<Record<'fr' | 'en' | 'ar', string>>;
  price: number;
  stock: number;
  images: { url: string }[];
  shop: { slug: string; name: string };
}

const productParams = z.object({ productId: z.uuid() }).strict();

/** The cart of the account when signed in, of the guest cookie otherwise (created on first use). */
function ownerOf(request: FastifyRequest, reply: FastifyReply, create: boolean): string | null {
  if (request.session) return `user:${request.session.userId}`;
  return request.guestCart() ?? (create ? reply.newGuestCart() : null);
}

export function registerCartRoutes(app: App, deps: CartDeps): void {
  const { carts, internal } = deps;

  /** The cart with what the catalog says now: price, stock, and whether it is still for sale. */
  async function view(request: FastifyRequest, cart: Cart) {
    const ids = [...cart.keys()];
    const products = new Map<string, CatalogProduct>();
    if (ids.length > 0) {
      const response = await internal.call<{ items: CatalogProduct[] }>('catalog', actorOf(null), {
        method: 'GET',
        path: `/products?ids=${ids.join(',')}`,
        requestId: request.id,
      });
      if (response.status !== 200)
        throw new ProblemError(503, 'Service Unavailable', 'The catalog is unavailable');
      for (const product of response.body.items) products.set(product.id, product);
    }
    const items = ids.map((productId) => {
      const quantity = cart.get(productId) ?? 0;
      const product = products.get(productId) ?? null;
      return {
        productId,
        quantity,
        product,
        // Withdrawn from sale, or less stock than asked: the buyer must adjust before paying.
        available: product !== null && product.stock >= quantity,
      };
    });
    return {
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal: items.reduce(
        (sum, item) => sum + (item.product ? item.product.price * item.quantity : 0),
        0,
      ),
      ready: items.length > 0 && items.every((item) => item.available),
    };
  }

  app.get('/api/cart', { schema: { tags: ['cart'] } }, async (request, reply) => {
    const owner = ownerOf(request, reply, false);
    return view(request, owner ? await carts.get(owner) : new Map<string, number>());
  });

  app.put(
    '/api/cart/items/:productId',
    {
      schema: {
        tags: ['cart'],
        params: productParams,
        body: z.object({ quantity: z.int().min(0).max(MAX_QUANTITY) }).strict(),
      },
    },
    async (request, reply) => {
      const owner = ownerOf(request, reply, true);
      if (!owner) throw new Error('Unreachable: a cart is created on demand');
      if (
        (await carts.set(owner, request.params.productId, request.body.quantity)) ===
        'too-many-lines'
      ) {
        throw new ProblemError(409, 'Conflict', 'A cart holds at most 50 different pieces');
      }
      return view(request, await carts.get(owner));
    },
  );

  app.delete(
    '/api/cart/items/:productId',
    { schema: { tags: ['cart'], params: productParams } },
    async (request, reply) => {
      const owner = ownerOf(request, reply, false);
      if (owner) await carts.set(owner, request.params.productId, 0);
      return view(request, owner ? await carts.get(owner) : new Map<string, number>());
    },
  );

  // ---- Checkout (US-05): the order is placed from the cart kept here, never from a client list

  app.post(
    '/api/checkout',
    {
      schema: {
        tags: ['cart'],
        headers: z.object({ 'idempotency-key': z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).loose(),
        body: z.object({ shippingAddress: z.record(z.string(), z.unknown()) }).strict(),
      },
    },
    async (request, reply) => {
      const session = requireSession(request);
      if (session.role !== 'buyer') throw forbidden('Only buyers place orders');
      const actor = actorOf(session);
      const owner = `user:${session.userId}`;
      const cart = await carts.get(owner);
      if (cart.size === 0) throw new ProblemError(409, 'Conflict', 'The cart is empty');
      const response = await internal.call('orders', actor, {
        method: 'POST',
        path: '/orders',
        body: {
          items: [...cart].map(([productId, quantity]) => ({ productId, quantity })),
          shippingAddress: request.body.shippingAddress,
        },
        headers: { 'idempotency-key': request.headers['idempotency-key'] },
        requestId: request.id,
      });
      // The cart is emptied once the order exists; a replay of the same key finds it empty.
      if (response.status === 200 || response.status === 202) await carts.clear(owner);
      return reply.code(response.status).send(response.body);
    },
  );
}
