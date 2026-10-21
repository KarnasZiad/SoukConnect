import type { Envelope, LocalizedText, OrderStatus } from '@soukconnect/contracts';
import type { Item, Line, Order, Shipment, ShippingAddress } from './domain/order.js';
import type { Decision, ShipmentRefusal } from './domain/saga.js';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

export interface NewOrder {
  buyerId: string;
  idempotencyKey: string;
  /** Digest of the request: the same key with another request is refused. */
  requestHash: string;
  items: Item[];
  shippingAddress: ShippingAddress;
}

/** The part of an order a seller sees: its own lines and shipment, never the other shops'. */
export interface SellerOrder {
  orderId: string;
  status: OrderStatus;
  lines: Line[];
  subtotal: number;
  commission: number;
  shipment: Shipment;
  shippingAddress: ShippingAddress;
  createdAt: Date;
}

export interface SellerStats {
  orders: number;
  revenue: number;
  commission: number;
  net: number;
  averageOrder: number;
  topProducts: { productId: string; title: LocalizedText; quantity: number; revenue: number }[];
}

export type SagaMessage = Envelope<
  | 'catalog.stock-reserved'
  | 'catalog.stock-rejected'
  | 'payments.payment-succeeded'
  | 'payments.payment-failed'
>;

export interface OrderStore {
  create(
    input: NewOrder,
  ): Promise<{ order: Order; created: boolean } | 'key-reused' | 'too-many-active'>;
  /**
   * Applies a saga step once (inbox): locks the order, lets `decide` compute the transition, and
   * writes the new state with its outgoing messages in the same transaction.
   */
  handle(message: SagaMessage, decide: (order: Order, now: Date) => Decision): Promise<void>;
  /** Cancels the orders whose payment deadline passed; returns how many. */
  expireDue(now: Date, limit: number): Promise<number>;
  cancel(buyerId: string, orderId: string): Promise<Order | 'not-cancellable' | null>;
  updateShipment(
    shopId: string,
    orderId: string,
    change: { status: 'SHIPPED' | 'DELIVERED'; trackingNumber?: string },
  ): Promise<Order | ShipmentRefusal>;
  getForBuyer(buyerId: string, orderId: string): Promise<Order | null>;
  listForBuyer(buyerId: string, page: number, perPage: number): Promise<Page<Order>>;
  listForShop(
    shopId: string,
    options: { status?: 'CONFIRMED' | 'FULFILLED'; page: number; perPage: number },
  ): Promise<Page<SellerOrder>>;
  statsForShop(shopId: string, since: Date): Promise<SellerStats>;
}
