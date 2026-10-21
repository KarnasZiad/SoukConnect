import {
  commissionOf,
  createEnvelope,
  type Envelope,
  type EnvelopeOptions,
  type LocalizedText,
  type OrderStatus,
  type ShipmentStatus,
  uuidv7,
} from '@soukconnect/contracts';
import { PermanentError } from '@soukconnect/messaging';
import { enqueue, markProcessed } from '@soukconnect/messaging/postgres';
import type { Sql, TransactionSql } from 'postgres';
import type { Item, Line, Order, Shipment, ShippingAddress } from '../domain/order.js';
import { cancelByBuyer, type Decision, expire, updateShipment } from '../domain/saga.js';
import type {
  NewOrder,
  OrderStore,
  Page,
  SagaMessage,
  SellerOrder,
  SellerStats,
} from '../ports.js';

export const SAGA_CONSUMER = 'orders.saga';
/** Orders not yet paid or rejected, per buyer: bounds what one account can hold in reserve (D2). */
export const MAX_ACTIVE_ORDERS = 5;
const UNIQUE_VIOLATION = '23505';

type Tx = TransactionSql;

interface OrderRow {
  id: string;
  buyer_id: string;
  status: OrderStatus;
  request_hash: string;
  total_amount: number | null;
  shipping_address: ShippingAddress;
  payment_deadline: Date | null;
  cancellation_reason: Order['cancellationReason'];
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  order_id: string;
  product_id: string;
  shop_id: string;
  title: LocalizedText;
  unit_price: number;
  quantity: number;
  commission_bps: number;
}

interface ShipmentRow {
  order_id: string;
  shop_id: string;
  status: ShipmentStatus;
  tracking_number: string | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
}

const toLine = (row: LineRow): Line => ({
  productId: row.product_id,
  shopId: row.shop_id,
  title: row.title,
  unitPrice: row.unit_price,
  quantity: row.quantity,
  commissionBps: row.commission_bps,
});

const toShipment = (row: ShipmentRow): Shipment => ({
  shopId: row.shop_id,
  status: row.status,
  trackingNumber: row.tracking_number,
  shippedAt: row.shipped_at,
  deliveredAt: row.delivered_at,
});

/** Orders in PostgreSQL; every state change and its messages share one transaction. */
export class PostgresOrderStore implements OrderStore {
  constructor(
    private readonly sql: Sql,
    /** Wakes the outbox relay after a commit. */
    private readonly onCommit: () => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const result = await this.sql.begin(work);
    this.onCommit();
    return result as T;
  }

  private async load(tx: Tx | Sql, rows: OrderRow[]): Promise<Order[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [items, lines, shipments] = await Promise.all([
      tx<(Item & { order_id: string })[]>`
        select order_id, product_id as "productId", quantity from order_items
        where order_id in ${tx(ids)} order by position`,
      tx<LineRow[]>`select * from order_lines where order_id in ${tx(ids)} order by position`,
      tx<ShipmentRow[]>`select * from shipments where order_id in ${tx(ids)} order by shop_id`,
    ]);
    return rows.map((row) => ({
      id: row.id,
      buyerId: row.buyer_id,
      status: row.status,
      items: items
        .filter((item) => item.order_id === row.id)
        .map(({ productId, quantity }) => ({ productId, quantity })),
      lines: lines.filter((line) => line.order_id === row.id).map(toLine),
      total: row.total_amount,
      currency: 'MAD',
      shippingAddress: row.shipping_address,
      paymentDeadline: row.payment_deadline,
      cancellationReason: row.cancellation_reason,
      shipments: shipments.filter((shipment) => shipment.order_id === row.id).map(toShipment),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private async loadOne(tx: Tx | Sql, rows: OrderRow[]): Promise<Order | null> {
    return (await this.load(tx, rows))[0] ?? null;
  }

  /** Writes a decision: new state, frozen lines, shipments, and the messages it sends. */
  private async apply(tx: Tx, order: Order, decision: Decision, origin: EnvelopeOptions) {
    const now = this.now();
    const fields: Record<string, unknown> = { updated_at: now };
    if (decision.status) fields.status = decision.status;
    if (decision.total !== undefined) fields.total_amount = decision.total;
    if (decision.paymentDeadline !== undefined) fields.payment_deadline = decision.paymentDeadline;
    if (decision.cancellationReason) fields.cancellation_reason = decision.cancellationReason;
    await tx`update orders set ${tx(fields)} where id = ${order.id}`;

    if (decision.lines) {
      for (const [position, line] of decision.lines.entries()) {
        await tx`
          insert into order_lines
            (order_id, position, product_id, shop_id, title, unit_price, quantity, commission_bps)
          values (${order.id}, ${position}, ${line.productId}, ${line.shopId}, ${tx.json(line.title)},
                  ${line.unitPrice}, ${line.quantity}, ${line.commissionBps})`;
      }
    }
    for (const shipment of decision.shipments ?? []) {
      await tx`
        insert into shipments (order_id, shop_id, status, tracking_number, shipped_at, delivered_at)
        values (${order.id}, ${shipment.shopId}, ${shipment.status}, ${shipment.trackingNumber},
                ${shipment.shippedAt}, ${shipment.deliveredAt})
        on conflict (order_id, shop_id) do update set
          status = excluded.status, tracking_number = excluded.tracking_number,
          shipped_at = excluded.shipped_at, delivered_at = excluded.delivered_at`;
    }
    const envelopes: Envelope[] = decision.messages.map((message) =>
      createEnvelope(message.type, message.payload as never, { ...origin, now }),
    );
    await enqueue(tx, envelopes);
  }

  async create(input: NewOrder): ReturnType<OrderStore['create']> {
    try {
      return await this.transaction(async (tx) => {
        const [existing] = await tx<OrderRow[]>`
          select * from orders
          where buyer_id = ${input.buyerId} and idempotency_key = ${input.idempotencyKey}`;
        if (existing) {
          if (existing.request_hash !== input.requestHash) return 'key-reused' as const;
          const order = await this.loadOne(tx, [existing]);
          return order ? { order, created: false } : ('key-reused' as const);
        }
        const [{ active } = { active: 0 }] = await tx<{ active: number }[]>`
          select count(*)::int as active from orders
          where buyer_id = ${input.buyerId} and status in ('PENDING', 'AWAITING_PAYMENT')`;
        if (active >= MAX_ACTIVE_ORDERS) return 'too-many-active' as const;

        const id = uuidv7();
        const rows = await tx<OrderRow[]>`
          insert into orders (id, buyer_id, status, idempotency_key, request_hash, shipping_address)
          values (${id}, ${input.buyerId}, 'PENDING', ${input.idempotencyKey}, ${input.requestHash},
                  ${tx.json(input.shippingAddress)})
          returning *`;
        for (const [position, item] of input.items.entries()) {
          await tx`
            insert into order_items (order_id, position, product_id, quantity)
            values (${id}, ${position}, ${item.productId}, ${item.quantity})`;
        }
        await enqueue(
          tx,
          createEnvelope(
            'catalog.reserve-stock',
            { orderId: id, items: input.items },
            { correlationId: id, now: this.now() },
          ),
        );
        const order = await this.loadOne(tx, rows);
        if (!order) throw new Error('Unreachable: the order was just inserted');
        return { order, created: true };
      });
    } catch (error) {
      // Two identical requests at the same instant: the loser reads what the winner created.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return this.create(input);
      throw error;
    }
  }

  async handle(message: SagaMessage, decide: (order: Order, now: Date) => Decision): Promise<void> {
    await this.transaction(async (tx) => {
      if (!(await markProcessed(tx, SAGA_CONSUMER, message.id))) return;
      const rows = await tx<OrderRow[]>`
        select * from orders where id = ${message.payload.orderId} for update`;
      const order = await this.loadOne(tx, rows);
      if (!order) throw new PermanentError(`Unknown order ${message.payload.orderId}`);
      await this.apply(tx, order, decide(order, this.now()), { causedBy: message });
    });
  }

  async expireDue(now: Date, limit: number): Promise<number> {
    return this.transaction(async (tx) => {
      // Several replicas sweep at once: each locks different orders.
      const rows = await tx<OrderRow[]>`
        select * from orders
        where status = 'AWAITING_PAYMENT' and payment_deadline < ${now}
        order by payment_deadline
        limit ${limit}
        for update skip locked`;
      for (const order of await this.load(tx, rows)) {
        await this.apply(tx, order, expire(order, now), { correlationId: order.id });
      }
      return rows.length;
    });
  }

  async cancel(buyerId: string, orderId: string) {
    return this.transaction(async (tx) => {
      const rows = await tx<OrderRow[]>`
        select * from orders where id = ${orderId} and buyer_id = ${buyerId} for update`;
      const order = await this.loadOne(tx, rows);
      if (!order) return null;
      const decision = cancelByBuyer(order);
      if (decision === 'not-cancellable') return decision;
      await this.apply(tx, order, decision, { correlationId: order.id });
      return this.loadOne(tx, await tx<OrderRow[]>`select * from orders where id = ${orderId}`);
    });
  }

  async updateShipment(
    shopId: string,
    orderId: string,
    change: { status: 'SHIPPED' | 'DELIVERED'; trackingNumber?: string },
  ) {
    return this.transaction(async (tx) => {
      const rows = await tx<OrderRow[]>`select * from orders where id = ${orderId} for update`;
      const order = await this.loadOne(tx, rows);
      if (!order) return 'not-found' as const;
      const decision = updateShipment(order, shopId, change, this.now());
      if (typeof decision === 'string') return decision;
      await this.apply(tx, order, decision, { correlationId: order.id });
      const updated = await this.loadOne(
        tx,
        await tx<OrderRow[]>`select * from orders where id = ${orderId}`,
      );
      return updated ?? ('not-found' as const);
    });
  }

  async getForBuyer(buyerId: string, orderId: string): Promise<Order | null> {
    return this.loadOne(
      this.sql,
      await this.sql<OrderRow[]>`
        select * from orders where id = ${orderId} and buyer_id = ${buyerId}`,
    );
  }

  async listForBuyer(buyerId: string, page: number, perPage: number): Promise<Page<Order>> {
    const [rows, [count]] = await Promise.all([
      this.sql<OrderRow[]>`
        select * from orders where buyer_id = ${buyerId}
        order by created_at desc limit ${perPage} offset ${(page - 1) * perPage}`,
      this.sql<{ total: number }[]>`
        select count(*)::int as total from orders where buyer_id = ${buyerId}`,
    ]);
    return { items: await this.load(this.sql, rows), total: count?.total ?? 0, page, perPage };
  }

  async listForShop(
    shopId: string,
    options: { status?: 'CONFIRMED' | 'FULFILLED'; page: number; perPage: number },
  ): Promise<Page<SellerOrder>> {
    const statuses = options.status ? [options.status] : ['CONFIRMED', 'FULFILLED'];
    const [rows, [count]] = await Promise.all([
      this.sql<OrderRow[]>`
        select o.* from orders o
        where o.status in ${this.sql(statuses)}
          and exists (select 1 from order_lines l where l.order_id = o.id and l.shop_id = ${shopId})
        order by o.created_at desc limit ${options.perPage}
        offset ${(options.page - 1) * options.perPage}`,
      this.sql<{ total: number }[]>`
        select count(*)::int as total from orders o
        where o.status in ${this.sql(statuses)}
          and exists (select 1 from order_lines l where l.order_id = o.id and l.shop_id = ${shopId})`,
    ]);
    const items = (await this.load(this.sql, rows)).flatMap((order): SellerOrder[] => {
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
          commission: commissionOf(subtotal, lines[0]?.commissionBps ?? 0),
          shipment,
          shippingAddress: order.shippingAddress,
          createdAt: order.createdAt,
        },
      ];
    });
    return { items, total: count?.total ?? 0, page: options.page, perPage: options.perPage };
  }

  async statsForShop(shopId: string, since: Date): Promise<SellerStats> {
    // Commission per order and shop, rounded like payments does (half up on the share).
    const [totals] = await this.sql<{ orders: number; revenue: number; commission: number }[]>`
      select count(*)::int as orders,
             coalesce(sum(subtotal), 0)::bigint as revenue,
             coalesce(sum(round(subtotal * bps / 10000.0)), 0)::bigint as commission
      from (
        select l.order_id, sum(l.unit_price * l.quantity) as subtotal, max(l.commission_bps) as bps
        from order_lines l join orders o on o.id = l.order_id
        where l.shop_id = ${shopId} and o.status in ('CONFIRMED', 'FULFILLED')
          and o.created_at >= ${since}
        group by l.order_id
      ) shares`;
    const topProducts = await this.sql<
      { productId: string; title: LocalizedText; quantity: number; revenue: number }[]
    >`
      select l.product_id as "productId", (array_agg(l.title))[1] as title,
             sum(l.quantity)::int as quantity, sum(l.unit_price * l.quantity)::bigint as revenue
      from order_lines l join orders o on o.id = l.order_id
      where l.shop_id = ${shopId} and o.status in ('CONFIRMED', 'FULFILLED')
        and o.created_at >= ${since}
      group by l.product_id
      order by quantity desc, revenue desc
      limit 5`;
    const orders = totals?.orders ?? 0;
    const revenue = totals?.revenue ?? 0;
    const commission = totals?.commission ?? 0;
    return {
      orders,
      revenue,
      commission,
      net: revenue - commission,
      averageOrder: orders === 0 ? 0 : Math.round(revenue / orders),
      topProducts: [...topProducts],
    };
  }
}
