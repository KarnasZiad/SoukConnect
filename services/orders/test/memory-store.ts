import { uuidv7 } from '@soukconnect/contracts';
import {
  createInternalVerifier,
  createLogger,
  generateSigningKeys,
  importSigningKey,
  parsePublicKeys,
  signInternalToken,
  type Actor,
} from '@soukconnect/service-kit';
import { buildApp } from '../src/app.js';
import type { Order } from '../src/domain/order.js';
import {
  cancelByBuyer,
  type Decision,
  expire,
  type Outgoing,
  updateShipment,
} from '../src/domain/saga.js';
import { MAX_ACTIVE_ORDERS } from '../src/postgres/order-store.js';
import type {
  NewOrder,
  OrderStore,
  Page,
  SagaMessage,
  SellerOrder,
  SellerStats,
} from '../src/ports.js';

/** Orders in memory, with the same decisions as the PostgreSQL store. */
export class MemoryOrderStore implements OrderStore {
  orders = new Map<string, Order & { key: string; hash: string }>();
  sent: Outgoing[] = [];
  processed = new Set<string>();

  private apply(order: Order, decision: Decision): Order {
    Object.assign(order, {
      ...(decision.status ? { status: decision.status } : {}),
      ...(decision.lines ? { lines: decision.lines } : {}),
      ...(decision.total !== undefined ? { total: decision.total } : {}),
      ...(decision.paymentDeadline !== undefined
        ? { paymentDeadline: decision.paymentDeadline }
        : {}),
      ...(decision.cancellationReason ? { cancellationReason: decision.cancellationReason } : {}),
      ...(decision.shipments ? { shipments: decision.shipments } : {}),
    });
    this.sent.push(...decision.messages);
    return order;
  }

  create(input: NewOrder) {
    const existing = [...this.orders.values()].find(
      (order) => order.buyerId === input.buyerId && order.key === input.idempotencyKey,
    );
    if (existing) {
      return Promise.resolve(
        existing.hash === input.requestHash
          ? { order: existing, created: false }
          : ('key-reused' as const),
      );
    }
    const active = [...this.orders.values()].filter(
      (order) =>
        order.buyerId === input.buyerId && ['PENDING', 'AWAITING_PAYMENT'].includes(order.status),
    );
    if (active.length >= MAX_ACTIVE_ORDERS) return Promise.resolve('too-many-active' as const);
    const now = new Date();
    const order = {
      id: uuidv7(),
      buyerId: input.buyerId,
      status: 'PENDING' as const,
      items: input.items,
      lines: [],
      total: null,
      currency: 'MAD' as const,
      shippingAddress: input.shippingAddress,
      paymentDeadline: null,
      cancellationReason: null,
      shipments: [],
      createdAt: now,
      updatedAt: now,
      key: input.idempotencyKey,
      hash: input.requestHash,
    };
    this.orders.set(order.id, order);
    this.sent.push({
      type: 'catalog.reserve-stock',
      payload: { orderId: order.id, items: input.items },
    });
    return Promise.resolve({ order, created: true });
  }

  handle(message: SagaMessage, decide: (order: Order, now: Date) => Decision): Promise<void> {
    if (this.processed.has(message.id)) return Promise.resolve();
    const order = this.orders.get(message.payload.orderId);
    if (!order) return Promise.reject(new Error('unknown order'));
    this.apply(order, decide(order, new Date()));
    this.processed.add(message.id);
    return Promise.resolve();
  }

  expireDue(now: Date, limit: number): Promise<number> {
    const due = [...this.orders.values()]
      .filter(
        (order) =>
          order.status === 'AWAITING_PAYMENT' &&
          order.paymentDeadline &&
          order.paymentDeadline < now,
      )
      .slice(0, limit);
    for (const order of due) this.apply(order, expire(order, now));
    return Promise.resolve(due.length);
  }

  cancel(buyerId: string, orderId: string) {
    const order = this.orders.get(orderId);
    if (order?.buyerId !== buyerId) return Promise.resolve(null);
    const decision = cancelByBuyer(order);
    return Promise.resolve(decision === 'not-cancellable' ? decision : this.apply(order, decision));
  }

  updateShipment(
    shopId: string,
    orderId: string,
    change: { status: 'SHIPPED' | 'DELIVERED'; trackingNumber?: string },
  ) {
    const order = this.orders.get(orderId);
    if (!order) return Promise.resolve('not-found' as const);
    const decision = updateShipment(order, shopId, change, new Date());
    return Promise.resolve(typeof decision === 'string' ? decision : this.apply(order, decision));
  }

  getForBuyer(buyerId: string, orderId: string): Promise<Order | null> {
    const order = this.orders.get(orderId);
    return Promise.resolve(order?.buyerId === buyerId ? order : null);
  }

  listForBuyer(buyerId: string, page: number, perPage: number): Promise<Page<Order>> {
    const items = [...this.orders.values()].filter((order) => order.buyerId === buyerId);
    return Promise.resolve({
      items: items.slice((page - 1) * perPage, page * perPage),
      total: items.length,
      page,
      perPage,
    });
  }

  listForShop(
    shopId: string,
    options: { status?: 'CONFIRMED' | 'FULFILLED'; page: number; perPage: number },
  ): Promise<Page<SellerOrder>> {
    const items = [...this.orders.values()]
      .filter((order) =>
        options.status
          ? order.status === options.status
          : ['CONFIRMED', 'FULFILLED'].includes(order.status),
      )
      .flatMap((order) => {
        const lines = order.lines.filter((line) => line.shopId === shopId);
        const shipment = order.shipments.find((entry) => entry.shopId === shopId);
        if (!shipment || lines.length === 0) return [];
        const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
        return [
          {
            orderId: order.id,
            status: order.status,
            lines,
            subtotal,
            commission: Math.round(subtotal / 10),
            shipment,
            shippingAddress: order.shippingAddress,
            createdAt: order.createdAt,
          },
        ];
      });
    return Promise.resolve({
      items,
      total: items.length,
      page: options.page,
      perPage: options.perPage,
    });
  }

  statsSince: Date | null = null;
  statsForShop(_shopId: string, since: Date): Promise<SellerStats> {
    this.statsSince = since;
    return Promise.resolve({
      orders: 2,
      revenue: 900_000,
      commission: 90_000,
      net: 810_000,
      averageOrder: 450_000,
      topProducts: [],
    });
  }
}

/** The orders API on the memory store, with real internal tokens. */
export async function testApp(now = () => new Date()) {
  const { privateJwk, publicJwk } = await generateSigningKeys('test');
  const key = await importSigningKey(JSON.stringify(privateJwk));
  const store = new MemoryOrderStore();
  const app = await buildApp({
    logger: createLogger('orders-test', 'silent'),
    store,
    now,
    verifyToken: createInternalVerifier({
      audience: 'orders',
      publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
    }),
  });
  async function call(
    actor: Actor,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await signInternalToken(key, 'orders', actor)}`,
        ...headers,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  return { app, store, call };
}
